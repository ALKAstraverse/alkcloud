import { StorageError, type ObjectStorage, type PresignPutRequest, type PresignPartRequest, type PresignedTarget, type MultipartPart, type ObjectStat, type ObjectVersion, type ListObjectsResult } from './port.js';

/**
 * WS-B — Độ bền của lớp lưu trữ (retry + circuit breaker).
 *
 * Bối cảnh: AlkCloud chạy trên Workers Free (CPU 10ms, 50 subrequest). B2 là
 * dịch vụ bên ngoài ⇒ có thể trả lỗi tạm thời (429/5xx) hoặc rớt mạng.
 * Không có retry ⇒ 1 lần rớt mạng = người dùng mất phiên upload/download.
 * Không có circuit breaker ⇒ mỗi request đều đợi timeout ⇒ Worker hết thời
 * gian và mọi request sau cũng chậm theo (throttling dây chuyền).
 *
 * Nguyên tắc:
 * - Chỉ retry thao tác **idempotent**. `createMultipartUpload` KHÔNG retry
 *   (retry sẽ tạo thêm upload mồ côi không biết uploadId để abort).
 * - Backoff **exponential + jitter** để tránh retry đồng loạt (thundering herd).
 * - Tổng thời gian sleep có trần ⇒ không vượt thời gian của một Worker request.
 * - Circuit breaker **fail-fast** khi B2 đang chết: trả lỗi 503 ngay thay vì
 *   để mọi request treo.
 */

export type CircuitState = 'closed' | 'open' | 'half-open';

export interface RetryPolicy {
	/** Số lần thử TỐI ĐA (kể cả lần đầu). */
	maxAttempts: number;
	/** Độ trễ base của backoff (ms). */
	baseDelayMs: number;
	/** Trần độ trễ mỗi lần (ms). */
	maxDelayMs: number;
	/** Tổng ngân sách sleep cho 1 lần gọi (ms) — bảo đảm bounded work. */
	totalDelayBudgetMs: number;
}

export const DEFAULT_RETRY_POLICY: RetryPolicy = {
	maxAttempts: 3,
	baseDelayMs: 100,
	maxDelayMs: 1000,
	totalDelayBudgetMs: 1500,
};

/** HTTP status có thể retry (lỗi tạm thời phía server). */
export const RETRYABLE_STATUSES = new Set([408, 425, 429, 500, 502, 503, 504]);

export interface CircuitBreakerOptions {
	/** Số lỗi liên tiếp để mở circuit. */
	failureThreshold: number;
	/** Thời gian mở circuit trước khi thử half-open (ms). */
	resetTimeoutMs: number;
	/** Nguồn thời gian (inject được để test). */
	now?: () => number;
	/** Nguồn ngủ (inject được để test). */
	sleep?: (ms: number) => Promise<void>;
}

export const DEFAULT_CIRCUIT_OPTIONS: CircuitBreakerOptions = {
	failureThreshold: 5,
	resetTimeoutMs: 30_000,
};

/** Lỗi khi circuit đang mở — fail-fast, không gọi xuống hạ tầng. */
export class CircuitOpenError extends StorageError {
	constructor(retryAfterSeconds: number) {
		super('Storage circuit đang mở — tạm thời không thể truy cập B2', 503, 'circuit_open');
		this.name = 'CircuitOpenError';
		this.retryAfterSeconds = retryAfterSeconds;
	}
	readonly retryAfterSeconds: number;
}

export function defaultSleep(ms: number): Promise<void> {
	return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Circuit breaker 3 trạng thái.
 *
 * - `closed`: bình thường, đếm lỗi liên tiếp.
 * - `open`: chặn mọi lời gọi trong `resetTimeoutMs` ⇒ fail-fast (503).
 * - `half-open`: cho đúng **1** lời gọi thử; thành công ⇒ `closed`, thất bại ⇒ `open` lại.
 */
export class CircuitBreaker {
	private state: CircuitState = 'closed';
	private consecutiveFailures = 0;
	private openedAtMs = 0;
	private halfOpenProbeInFlight = false;
	private readonly now: () => number;
	private readonly sleep: (ms: number) => Promise<void>;

	constructor(private readonly options: CircuitBreakerOptions = DEFAULT_CIRCUIT_OPTIONS) {
		this.now = options.now ?? (() => Date.now());
		this.sleep = options.sleep ?? defaultSleep;
	}

	getState(): CircuitState {
		if (this.state === 'open' && this.now() - this.openedAtMs >= this.options.resetTimeoutMs) {
			return 'half-open';
		}
		return this.state;
	}

	getFailureCount(): number {
		return this.consecutiveFailures;
	}

	/** Số giây client nên chờ trước khi thử lại. */
	retryAfterSeconds(): number {
		if (this.state !== 'open') return 0;
		const remaining = this.options.resetTimeoutMs - (this.now() - this.openedAtMs);
		return Math.max(1, Math.ceil(remaining / 1000));
	}

	async execute<T>(operation: () => Promise<T>): Promise<T> {
		const state = this.getState();
		if (state === 'open') {
			throw new CircuitOpenError(this.retryAfterSeconds());
		}
		if (state === 'half-open') {
			if (this.halfOpenProbeInFlight) {
				throw new CircuitOpenError(this.retryAfterSeconds());
			}
			this.halfOpenProbeInFlight = true;
			try {
				const result = await operation();
				this.onSuccess();
				return result;
			} catch (error) {
				this.onFailure();
				throw error;
			} finally {
				this.halfOpenProbeInFlight = false;
			}
		}

		try {
			const result = await operation();
			this.onSuccess();
			return result;
		} catch (error) {
			this.onFailure();
			throw error;
		}
	}

	private onSuccess(): void {
		this.consecutiveFailures = 0;
		this.state = 'closed';
		this.openedAtMs = 0;
	}

	private onFailure(): void {
		this.consecutiveFailures += 1;
		if (this.state === 'half-open' || this.consecutiveFailures >= this.options.failureThreshold) {
			this.state = 'open';
			this.openedAtMs = this.now();
		}
	}

	/** Ép circuit về closed (dùng cho test/reset thủ công). */
	reset(): void {
		this.onSuccess();
	}
}

/**
 * Lỗi storage có thể retry không?
 * - `StorageError` có status 408/425/429/5xx ⇒ lỗi tạm thời server.
 * - `StorageError` **không** có status ⇒ lỗi protocol/mạng nội bộ (KHÔNG retry:
 *   ví dụ response thiếu UploadId sẽ cho kết quả giống nhau mọi lần).
 * - `TypeError`/`AbortError` từ `fetch` ⇒ lỗi mạng ⇒ retry.
 */
export function isRetryableStorageError(error: unknown): boolean {
	if (error instanceof StorageError) {
		if (error.status === undefined || error.status === null) return false;
		return RETRYABLE_STATUSES.has(error.status);
	}
	if (error instanceof Error) {
		return error.name === 'TypeError' || error.name === 'AbortError' || error.name === 'TimeoutError';
	}
	return false;
}

/** Backoff exponential + jitter (full jitter) — tránh retry đồng loạt. */
export function backoffDelayMs(attempt: number, policy: RetryPolicy, random: () => number = Math.random): number {
	const exponential = policy.baseDelayMs * 2 ** Math.max(0, attempt - 1);
	const capped = Math.min(exponential, policy.maxDelayMs);
	return Math.floor(capped * (0.5 + random() * 0.5));
}

/**
 * Sự kiện observability của lớp lưu trữ (WS-K).
 *
 * Gói `packages/storage` cố tình **không** phụ thuộc vào tầng ứng dụng ⇒ không
 * tự log. Thay vào đó nó phát sự kiện qua callback, để app nối vào hệ thống log
 * có cấu trúc (redact + catalog) của mình.
 */
export interface StorageEvent {
	type: 'retry' | 'circuit_open' | 'failure';
	/** Tên thao tác (không chứa key object — key có thể chứa định danh người dùng). */
	operation: string;
	attempt?: number;
	delayMs?: number;
	errorName?: string;
	status?: number;
}

export interface ResilienceOptions {
	retry?: RetryPolicy;
	circuit?: CircuitBreakerOptions;
	/** Circuit breaker dùng chung (mặc định: tạo riêng cho decorator này). */
	breaker?: CircuitBreaker;
	now?: () => number;
	sleep?: (ms: number) => Promise<void>;
	random?: () => number;
	/** Nhận sự kiện retry / circuit-open / failure (WS-K). */
	onEvent?: (event: StorageEvent) => void;
}

/**
 * Decorator bọc `ObjectStorage`: thêm retry + circuit breaker mà không sửa
 * adapter cụ thể (B2, mock, hay adapter test đều được hưởng).
 */
export class ResilientStorage implements ObjectStorage {
	private readonly inner: ObjectStorage;
	private readonly policy: RetryPolicy;
	private readonly breaker: CircuitBreaker;
	private readonly sleep: (ms: number) => Promise<void>;
	private readonly random: () => number;
	private readonly onEvent: ((event: StorageEvent) => void) | undefined;
	/** Thống kê để test + observability. */
	readonly stats = { attempts: 0, retries: 0, circuitOpens: 0, failures: 0 };

	constructor(inner: ObjectStorage, options: ResilienceOptions = {}) {
		this.inner = inner;
		this.policy = options.retry ?? DEFAULT_RETRY_POLICY;
		const breakerOptions = options.circuit ?? DEFAULT_CIRCUIT_OPTIONS;
		this.breaker =
			options.breaker ??
			new CircuitBreaker({
				...breakerOptions,
				now: options.now ?? breakerOptions.now,
				sleep: options.sleep ?? breakerOptions.sleep,
			});
		this.sleep = options.sleep ?? defaultSleep;
		this.random = options.random ?? Math.random;
		this.onEvent = options.onEvent;
	}

	/** Phát sự kiện observability (không để lỗi callback làm hỏng request). */
	private emitEvent(event: StorageEvent): void {
		if (!this.onEvent) return;
		try {
			this.onEvent(event);
		} catch {
			// Callback hỏng không được làm hỏng thao tác lưu trữ.
		}
	}

	getCircuitState(): CircuitState {
		return this.breaker.getState();
	}

	/** Chạy 1 thao tác idempotent với retry + circuit breaker. */
	private async withResilience<T>(operation: () => Promise<T>, operationName = 'unknown'): Promise<T> {
		let lastError: unknown;
		let spentDelay = 0;

		for (let attempt = 1; attempt <= this.policy.maxAttempts; attempt++) {
			this.stats.attempts += 1;
			try {
				return await this.breaker.execute(operation);
			} catch (error) {
				lastError = error;
				this.stats.failures += 1;
				if (error instanceof CircuitOpenError) {
					this.stats.circuitOpens += 1;
					this.emitEvent({
						type: 'circuit_open',
						operation: operationName,
						attempt,
						errorName: error.name,
					});
					throw error;
				}
				if (attempt >= this.policy.maxAttempts) break;
				if (!isRetryableStorageError(error)) break;

				const delay = backoffDelayMs(attempt, this.policy, this.random);
				if (spentDelay + delay > this.policy.totalDelayBudgetMs) break;
				spentDelay += delay;
				this.stats.retries += 1;
				this.emitEvent({
					type: 'retry',
					operation: operationName,
					attempt,
					delayMs: delay,
					errorName: error instanceof Error ? error.name : 'unknown',
					status: error instanceof StorageError ? error.status : undefined,
				});
				await this.sleep(delay);
			}
		}
		this.emitEvent({
			type: 'failure',
			operation: operationName,
			attempt: this.policy.maxAttempts,
			errorName: lastError instanceof Error ? lastError.name : 'unknown',
			status: lastError instanceof StorageError ? lastError.status : undefined,
		});
		throw lastError;
	}

	/** Presign chỉ tính toán chữ ký — không gọi mạng ⇒ không retry, không circuit. */
	async presignPut(request: PresignPutRequest): Promise<PresignedTarget> {
		return this.inner.presignPut(request);
	}

	async presignUploadPart(request: PresignPartRequest): Promise<PresignedTarget> {
		return this.inner.presignUploadPart(request);
	}

	async presignGet(request: {
		key: string;
		expiresInSeconds?: number;
		responseContentType?: string;
	}): Promise<PresignedTarget> {
		return this.inner.presignGet(request);
	}

	/**
	 * KHÔNG retry: mỗi lần thử lại tạo thêm 1 multipart upload mà không biết
	 * `uploadId` của bản cũ ⇒ rò multipart upload (bị B2 tính phí).
	 */
	async createMultipartUpload(request: { key: string; contentType: string }): Promise<{ uploadId: string }> {
		this.stats.attempts += 1;
		try {
			return await this.breaker.execute(() => this.inner.createMultipartUpload(request));
		} catch (error) {
			this.stats.failures += 1;
			throw error;
		}
	}

	async completeMultipartUpload(request: {
		key: string;
		uploadId: string;
		parts: MultipartPart[];
	}): Promise<{ etag: string | null; size: number | null }> {
		return this.withResilience(() => this.inner.completeMultipartUpload(request), 'completeMultipartUpload');
	}

	async abortMultipartUpload(request: { key: string; uploadId: string }): Promise<void> {
		return this.withResilience(() => this.inner.abortMultipartUpload(request), 'abortMultipartUpload');
	}

	async listParts(request: { key: string; uploadId: string }): Promise<MultipartPart[]> {
		return this.withResilience(() => this.inner.listParts(request), 'listParts');
	}

	async headObject(key: string): Promise<ObjectStat | null> {
		return this.withResilience(() => this.inner.headObject(key), 'headObject');
	}

	async getObject(key: string, range?: string): Promise<Response> {
		return this.withResilience(() => this.inner.getObject(key, range), 'getObject');
	}

	async deleteObject(key: string): Promise<void> {
		return this.withResilience(() => this.inner.deleteObject(key), 'deleteObject');
	}

	async listObjectVersions(key: string): Promise<ObjectVersion[]> {
		return this.withResilience(() => this.inner.listObjectVersions(key), 'listObjectVersions');
	}

	async deleteObjectVersion(key: string, versionId: string): Promise<void> {
		return this.withResilience(() => this.inner.deleteObjectVersion(key, versionId), 'deleteObjectVersion');
	}

	async listObjects(request?: {
		prefix?: string;
		continuationToken?: string;
		maxKeys?: number;
	}): Promise<ListObjectsResult> {
		return this.withResilience(() => this.inner.listObjects(request), 'listObjects');
	}
}
