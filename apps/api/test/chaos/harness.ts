/**
 * AlkCloud — chaos harness: công cụ tiêm lỗi (fault injection) cho test.
 *
 * Mục tiêu: chứng minh rằng khi hạ tầng/storage/database hỏng, hệ thống
 * KHÔNG mất dữ liệu, KHÔNG rò rỉ quota, KHÔNG tạo file trùng, và KHÔNG rò
 * thông tin nội bộ ra response.
 *
 * Nguyên tắc:
 * - Tất cả lỗi tiêm đều là lỗi I/O giả lập (timeout / 5xx / disconnect),
 *   KHÔNG bao giờ mô phỏng lỗi logic.
 * - Mọi helper đều "bất biến" (deterministic): cùng cấu hình ⇒ cùng kết quả.
 * - Harness chỉ dùng cho test local — KHÔNG dùng trên production.
 */

import { MockObjectStorage, type ObjectStorage } from '@alkcloud/storage';
import type { SqlDriver, SqlMeta, SqlResult, SqlStatement } from '@alkcloud/db';
import type { Database } from '@alkcloud/db';

/** Kiểu lỗi I/O giả lập. */
export type FaultMode = 'timeout' | 'server_error' | 'disconnect' | 'conflict';

/** Lỗi mô phỏng timeout của B2/D1 (không phải lỗi nghiệp vụ của app). */
export class InjectedFaultError extends Error {
	constructor(
		readonly operation: string,
		readonly mode: FaultMode,
	) {
		super(`[chaos] ${mode} tại ${operation}`);
		this.name = 'InjectedFaultError';
	}
}

/**
 * Bộ quy tắc lỗi cho storage.
 *
 * - `failOnce`: lỗi đúng 1 lần cho operation khớp ⇒ mô phỏng lỗi tạm thời.
 * - `failAlways`: lỗi mọi lần cho operation khớp.
 * - `failOnCall`: lỗi ở lần gọi thứ N (1-based) — dùng để mô phỏng "hỏng giữa chừng".
 */
export interface StorageFaultRule {
	operation: keyof ObjectStorage | '*';
	mode: FaultMode;
	times?: number;
	onCall?: number;
}

export interface FaultyStorageOptions {
	storage?: ObjectStorage;
	rules?: StorageFaultRule[];
}

export interface FaultyStorage extends ObjectStorage {
	/** Số lần gọi từng operation (để assert retry/backoff). */
	calls: Record<string, number>;
	/** Danh sách lỗi đã ném. */
	faults: Array<{ operation: string; mode: FaultMode }>;
	/** Helper của mock storage (chỉ có khi inner là MockObjectStorage). */
	keyFromPresignedUrl(url: string): string;
	putObject(key: string, object: { size: number; contentType: string; etag: string; body: Uint8Array }): void;
	setRules(rules: StorageFaultRule[]): void;
	clearRules(): void;
}

/** Tạo storage có thể tiêm lỗi. */
export function createFaultyStorage(options: FaultyStorageOptions = {}): FaultyStorage {
	const inner = options.storage ?? new MockObjectStorage();
	let rules: StorageFaultRule[] = [...(options.rules ?? [])];
	const calls: Record<string, number> = {};
	const faults: Array<{ operation: string; mode: FaultMode }> = [];
	const perRuleUsage = new Map<StorageFaultRule, number>();

	const check = (operation: string): void => {
		calls[operation] = (calls[operation] ?? 0) + 1;
		for (const rule of rules) {
			if (rule.operation !== '*' && rule.operation !== operation) continue;
			const used = perRuleUsage.get(rule) ?? 0;
			if (rule.onCall !== undefined) {
				if (calls[operation] !== rule.onCall) continue;
			} else if (rule.times !== undefined && used >= rule.times) {
				continue;
			}
			perRuleUsage.set(rule, used + 1);
			faults.push({ operation, mode: rule.mode });
			throw new InjectedFaultError(operation, rule.mode);
		}
	};

	const mock = inner instanceof MockObjectStorage ? inner : null;
	const proxy: FaultyStorage = {
		calls,
		faults,
		keyFromPresignedUrl(url: string): string {
			if (!mock) throw new Error('[chaos] keyFromPresignedUrl cần MockObjectStorage');
			return mock.keyFromPresignedUrl(url);
		},
		putObject(key: string, object: { size: number; contentType: string; etag: string; body: Uint8Array }): void {
			if (!mock) throw new Error('[chaos] putObject cần MockObjectStorage');
			mock.putObject(key, object);
		},
		setRules(next) {
			rules = [...next];
			perRuleUsage.clear();
		},
		clearRules() {
			rules = [];
			perRuleUsage.clear();
		},
		async presignPut(request) {
			check('presignPut');
			return inner.presignPut(request);
		},
		async presignUploadPart(request) {
			check('presignUploadPart');
			return inner.presignUploadPart(request);
		},
		async presignGet(request) {
			check('presignGet');
			return inner.presignGet(request);
		},
		async createMultipartUpload(request) {
			check('createMultipartUpload');
			return inner.createMultipartUpload(request);
		},
		async completeMultipartUpload(request) {
			check('completeMultipartUpload');
			return inner.completeMultipartUpload(request);
		},
		async abortMultipartUpload(request) {
			check('abortMultipartUpload');
			return inner.abortMultipartUpload(request);
		},
		async listParts(request) {
			check('listParts');
			return inner.listParts(request);
		},
		async headObject(key) {
			check('headObject');
			return inner.headObject(key);
		},
		async getObject(key, range) {
			check('getObject');
			return inner.getObject(key, range);
		},
		async deleteObject(key) {
			check('deleteObject');
			return inner.deleteObject(key);
		},
		async listObjectVersions(key) {
			check('listObjectVersions');
			return inner.listObjectVersions(key);
		},
		async deleteObjectVersion(key, versionId) {
			check('deleteObjectVersion');
			return inner.deleteObjectVersion(key, versionId);
		},
		async listObjects(request) {
			check('listObjects');
			return inner.listObjects(request);
		},
	};
	return proxy;
}

/**
 * Driver D1 có thể tiêm lỗi ghi/đọc.
 * Dùng để mô phỏng: D1 timeout, D1 write fail sau khi B2 đã thành công.
 */
export interface FaultyDriverOptions {
	driver: SqlDriver;
	/** Lỗi khi SQL khớp regex (mặc định: mọi lệnh ghi). */
	failOn?: RegExp;
	operation?: 'query' | 'run' | 'batch' | 'exec';
	mode?: FaultMode;
	times?: number;
}

export interface FaultyDriver extends SqlDriver {
	calls: { query: number; run: number; batch: number; exec: number };
	faults: Array<{ sql: string; mode: FaultMode }>;
	setRule(rule: { failOn?: RegExp; operation?: 'query' | 'run' | 'batch' | 'exec'; mode?: FaultMode; times?: number }): void;
	clearRule(): void;
}

export function createFaultyDriver(options: FaultyDriverOptions): FaultyDriver {
	const inner = options.driver;
	let rule: {
		failOn?: RegExp;
		operation?: 'query' | 'run' | 'batch' | 'exec';
		mode?: FaultMode;
		times?: number;
	} = {
		failOn: options.failOn,
		operation: options.operation,
		mode: options.mode,
		times: options.times,
	};
	let used = 0;
	const calls = { query: 0, run: 0, batch: 0, exec: 0 };
	const faults: Array<{ sql: string; mode: FaultMode }> = [];

	const shouldFail = (sql: string, operation: string): boolean => {
		calls[operation as keyof typeof calls] += 1;
		// Chỉ tiêm lỗi khi có pattern SQL tường minh — không bao giờ "fail mặc định".
		if (!rule.failOn) return false;
		const target = rule.operation ?? 'run';
		if (target !== operation) return false;
		if (!rule.failOn.test(sql)) return false;
		if (rule.times !== undefined && used >= rule.times) return false;
		used += 1;
		faults.push({ sql, mode: rule.mode ?? 'server_error' });
		return true;
	};

	return {
		calls,
		faults,
		setRule(next) {
			rule = { ...rule, ...next };
			used = 0;
		},
		clearRule() {
			rule = {};
			used = 0;
		},
		async query<T>(sql: string, params?: unknown[]): Promise<SqlResult<T>> {
			if (shouldFail(sql, 'query')) throw new InjectedFaultError('db.query', rule.mode ?? 'server_error');
			return inner.query<T>(sql, params);
		},
		async run(sql: string, params?: unknown[]): Promise<SqlMeta> {
			if (shouldFail(sql, 'run')) throw new InjectedFaultError('db.run', rule.mode ?? 'server_error');
			return inner.run(sql, params);
		},
		async batch(statements: SqlStatement[]): Promise<SqlResult[]> {
			if (shouldFail(statements[0]?.sql ?? '', 'batch')) {
				throw new InjectedFaultError('db.batch', rule.mode ?? 'server_error');
			}
			return inner.batch(statements);
		},
		async exec(sql: string): Promise<void> {
			if (shouldFail(sql, 'exec')) throw new InjectedFaultError('db.exec', rule.mode ?? 'server_error');
			return inner.exec(sql);
		},
	};
}

/** Chờ một khoảng thời gian (ms) — dùng để mô phỏng độ trễ. */
export function sleep(ms: number): Promise<void> {
	return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Request bị huỷ giữa chừng (client disconnect).
 * Dùng để kiểm tra: server KHÔNG được để lại state nửa vời.
 */
export function abortedRequest(url: string, init: RequestInit = {}): Request {
	const controller = new AbortController();
	const request = new Request(url, { ...init, signal: controller.signal });
	controller.abort();
	return request;
}

/**
 * Kiểm tra bất biến "không mất dữ liệu":
 * mọi file trong D1 phải có object tương ứng trong storage.
 */
export async function listAllFiles(db: Database): Promise<Array<{ id: string; objectKey: string; deletedAt: string | null }>> {
	const active = await db.listFiles({ folderId: undefined, deletedOnly: false, limit: 1000, offset: 0 });
	const deleted = await db.listFiles({ folderId: undefined, deletedOnly: true, limit: 1000, offset: 0 });
	return [...active, ...deleted];
}

export async function assertNoMetadataWithoutObject(
	db: Database,
	storage: ObjectStorage,
): Promise<void> {
	const files = await listAllFiles(db);
	for (const file of files) {
		const stat = await storage.headObject(file.objectKey);
		if (!stat) {
			throw new Error(`[chaos] metadata không có object: ${file.id} → ${file.objectKey}`);
		}
	}
}

/** Lấy tổng byte đang được reserve trong D1 (dùng để phát hiện rò quota). */
export async function totalReservedBytes(db: Database, ownerId: string): Promise<number> {
	return db.reservedQuotaBytes(ownerId);
}

/** Lấy owner id hiện tại (dùng cho assert quota). */
export async function currentOwnerId(db: Database): Promise<string> {
	const owner = await db.getOwner();
	if (!owner) throw new Error('[chaos] chưa có owner');
	return owner.id;
}
