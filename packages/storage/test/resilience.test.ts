import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import {
	CircuitBreaker,
	CircuitOpenError,
	DEFAULT_RETRY_POLICY,
	ResilientStorage,
	backoffDelayMs,
	isRetryableStorageError,
	type ObjectStorage,
	type ResilienceOptions,
} from '../src/index.js';
import { StorageError } from '../src/port.js';

/**
 * WS-B — test độ bền lớp lưu trữ (retry + circuit breaker).
 *
 * Nguyên tắc kiểm thử: mọi thao tác phải **bounded** (giới hạn số lần thử và
 * tổng thời gian sleep) — không có vòng lặp vô hạn theo lỗi hạ tầng.
 */

/** Storage giả đếm số lần gọi và trả lỗi theo kịch bản. */
class FlakyStorage implements ObjectStorage {
	calls: string[] = [];
	failuresRemaining = 0;
	failure: () => Error = () => new StorageError('boom', 503);

	async presignPut() {
		this.calls.push('presignPut');
		return { url: 'https://x/put', method: 'PUT' as const, headers: {}, expiresAt: '2026-01-01T00:00:00.000Z' };
	}
	async presignUploadPart() {
		this.calls.push('presignUploadPart');
		return { url: 'https://x/part', method: 'PUT' as const, headers: {}, expiresAt: '2026-01-01T00:00:00.000Z' };
	}
	async presignGet() {
		this.calls.push('presignGet');
		return { url: 'https://x/get', method: 'GET' as const, headers: {}, expiresAt: '2026-01-01T00:00:00.000Z' };
	}
	async createMultipartUpload() {
		this.calls.push('createMultipartUpload');
		this.maybeFail();
		return { uploadId: 'upl_1' };
	}
	async completeMultipartUpload() {
		this.calls.push('completeMultipartUpload');
		this.maybeFail();
		return { etag: 'e', size: 5 };
	}
	async abortMultipartUpload() {
		this.calls.push('abortMultipartUpload');
		this.maybeFail();
	}
	async listParts() {
		this.calls.push('listParts');
		this.maybeFail();
		return [];
	}
	async headObject() {
		this.calls.push('headObject');
		this.maybeFail();
		return null;
	}
	async getObject() {
		this.calls.push('getObject');
		this.maybeFail();
		return new Response('x');
	}
	async deleteObject() {
		this.calls.push('deleteObject');
		this.maybeFail();
	}
	async listObjectVersions() {
		this.calls.push('listObjectVersions');
		this.maybeFail();
		return [];
	}
	async deleteObjectVersion() {
		this.calls.push('deleteObjectVersion');
		this.maybeFail();
	}
	async listObjects() {
		this.calls.push('listObjects');
		this.maybeFail();
		return { objects: [], nextContinuationToken: null };
	}

	private maybeFail(): void {
		if (this.failuresRemaining > 0) {
			this.failuresRemaining -= 1;
			throw this.failure();
		}
	}
}

function makeResilient(inner: ObjectStorage, options: ResilienceOptions = {}) {
	const sleeps: number[] = [];
	const storage = new ResilientStorage(inner, {
		sleep: async (ms) => {
			sleeps.push(ms);
		},
		random: () => 0.5,
		...options,
	});
	return { storage, sleeps };
}

describe('WS-B — retry', () => {
	it('lỗi 503 tạm thời ⇒ retry rồi thành công', async () => {
		const inner = new FlakyStorage();
		inner.failuresRemaining = 2;
		const { storage, sleeps } = makeResilient(inner);

		const result = await storage.headObject('objects/a');
		assert.equal(result, null);
		assert.equal(inner.calls.filter((call) => call === 'headObject').length, 3, 'phải thử 3 lần');
		assert.equal(sleeps.length, 2, 'phải ngủ giữa 2 lần retry');
	});

	it('lỗi 429 (throttle) ⇒ retry', async () => {
		const inner = new FlakyStorage();
		inner.failuresRemaining = 1;
		inner.failure = () => new StorageError('slow down', 429);
		const { storage } = makeResilient(inner);
		await storage.headObject('objects/a');
		assert.equal(inner.calls.filter((call) => call === 'headObject').length, 2);
	});

	it('lỗi 404 ⇒ KHÔNG retry (lỗi client, retry vô nghĩa)', async () => {
		const inner = new FlakyStorage();
		inner.failuresRemaining = 5;
		inner.failure = () => new StorageError('not found', 404);
		const { storage } = makeResilient(inner);
		await assert.rejects(() => storage.headObject('objects/a'), /not found/);
		assert.equal(inner.calls.filter((call) => call === 'headObject').length, 1, '404 chỉ thử 1 lần');
	});

	it('lỗi protocol (StorageError không có status) ⇒ KHÔNG retry', async () => {
		const inner = new FlakyStorage();
		inner.failuresRemaining = 5;
		inner.failure = () => new StorageError('thiếu UploadId');
		const { storage } = makeResilient(inner);
		await assert.rejects(() => storage.headObject('objects/a'), /thiếu UploadId/);
		assert.equal(inner.calls.filter((call) => call === 'headObject').length, 1);
	});

	it('lỗi mạng (TypeError) ⇒ retry', async () => {
		const inner = new FlakyStorage();
		inner.failuresRemaining = 1;
		inner.failure = () => {
			const error = new TypeError('network error');
			return error;
		};
		const { storage } = makeResilient(inner);
		await storage.headObject('objects/a');
		assert.equal(inner.calls.filter((call) => call === 'headObject').length, 2);
	});

	it('hết số lần thử ⇒ ném lỗi gốc (không nuốt lỗi)', async () => {
		const inner = new FlakyStorage();
		inner.failuresRemaining = 99;
		const { storage } = makeResilient(inner);
		await assert.rejects(() => storage.headObject('objects/a'), /boom/);
		assert.equal(inner.calls.filter((call) => call === 'headObject').length, DEFAULT_RETRY_POLICY.maxAttempts);
	});

	it('createMultipartUpload KHÔNG retry (tránh rò multipart upload)', async () => {
		const inner = new FlakyStorage();
		inner.failuresRemaining = 99;
		const { storage } = makeResilient(inner);
		await assert.rejects(() => storage.createMultipartUpload({ key: 'k', contentType: 'text/plain' }), /boom/);
		assert.equal(inner.calls.filter((call) => call === 'createMultipartUpload').length, 1);
	});

	it('presign KHÔNG gọi hạ tầng ⇒ không bị circuit chặn', async () => {
		const inner = new FlakyStorage();
		const { storage } = makeResilient(inner);
		// làm circuit mở
		inner.failuresRemaining = 99;
		await assert.rejects(() => storage.headObject('k'));
		// presign vẫn phải chạy được (chỉ tính toán chữ ký)
		const target = await storage.presignPut({ key: 'k' });
		assert.equal(target.method, 'PUT');
	});

	it('tổng thời gian sleep có trần', async () => {
		const inner = new FlakyStorage();
		inner.failuresRemaining = 99;
		const { storage, sleeps } = makeResilient(inner, {
			retry: { maxAttempts: 10, baseDelayMs: 1000, maxDelayMs: 1000, totalDelayBudgetMs: 2500 },
		});
		await assert.rejects(() => storage.headObject('k'));
		const total = sleeps.reduce((sum, ms) => sum + ms, 0);
		assert.ok(total <= 2500, `tổng sleep ${total}ms phải ≤ budget 2500ms`);
	});
});

describe('WS-B — circuit breaker', () => {
	it('sau N lỗi liên tiếp ⇒ circuit mở và fail-fast', async () => {
		let now = 1_000_000;
		const inner = new FlakyStorage();
		inner.failuresRemaining = 999;
		const { storage } = makeResilient(inner, {
			retry: { maxAttempts: 1, baseDelayMs: 0, maxDelayMs: 0, totalDelayBudgetMs: 0 },
			circuit: { failureThreshold: 2, resetTimeoutMs: 30_000, now: () => now },
		});

		await assert.rejects(() => storage.headObject('k'), /boom/);
		await assert.rejects(() => storage.headObject('k'), /boom/);
		assert.equal(storage.getCircuitState(), 'open');

		const callsBefore = inner.calls.length;
		const error = await storage.headObject('k').catch((caught: unknown) => caught);
		assert.ok(error instanceof CircuitOpenError, 'phải ném CircuitOpenError');
		assert.equal(inner.calls.length, callsBefore, 'circuit mở ⇒ KHÔNG gọi xuống hạ tầng');
		assert.ok((error as CircuitOpenError).retryAfterSeconds > 0);
	});

	it('sau resetTimeout ⇒ half-open, probe thành công ⇒ đóng circuit', async () => {
		let now = 1_000_000;
		const inner = new FlakyStorage();
		const { storage } = makeResilient(inner, {
			retry: { maxAttempts: 1, baseDelayMs: 0, maxDelayMs: 0, totalDelayBudgetMs: 0 },
			circuit: { failureThreshold: 2, resetTimeoutMs: 10_000, now: () => now },
		});

		inner.failuresRemaining = 99;
		await assert.rejects(() => storage.headObject('k'));
		await assert.rejects(() => storage.headObject('k'));
		assert.equal(storage.getCircuitState(), 'open');

		// hết timeout + B2 đã khoẻ lại
		now += 11_000;
		inner.failuresRemaining = 0;
		await storage.headObject('k');
		assert.equal(storage.getCircuitState(), 'closed');
	});

	it('half-open probe thất bại ⇒ mở lại circuit', async () => {
		let now = 1_000_000;
		const inner = new FlakyStorage();
		const { storage } = makeResilient(inner, {
			retry: { maxAttempts: 1, baseDelayMs: 0, maxDelayMs: 0, totalDelayBudgetMs: 0 },
			circuit: { failureThreshold: 1, resetTimeoutMs: 10_000, now: () => now },
		});

		inner.failuresRemaining = 99;
		await assert.rejects(() => storage.headObject('k'));
		assert.equal(storage.getCircuitState(), 'open');

		now += 11_000;
		await assert.rejects(() => storage.headObject('k'), /boom/);
		assert.equal(storage.getCircuitState(), 'open', 'probe thất bại ⇒ mở lại');
	});

	it('lỗi thành công ⇒ reset bộ đếm lỗi liên tiếp', async () => {
		let now = 1_000_000;
		const inner = new FlakyStorage();
		const { storage } = makeResilient(inner, {
			retry: { maxAttempts: 3, baseDelayMs: 0, maxDelayMs: 0, totalDelayBudgetMs: 0 },
			circuit: { failureThreshold: 3, resetTimeoutMs: 10_000, now: () => now },
		});

		inner.failuresRemaining = 1;
		await storage.headObject('k'); // 1 lỗi (rồi retry thành công)
		inner.failuresRemaining = 1;
		await storage.headObject('k'); // 1 lỗi nữa
		assert.equal(storage.getCircuitState(), 'closed', 'lỗi không liên tiếp ⇒ không mở circuit');
	});
});

describe('WS-B — helper', () => {
	it('isRetryableStorageError phân loại đúng', () => {
		assert.equal(isRetryableStorageError(new StorageError('x', 503)), true);
		assert.equal(isRetryableStorageError(new StorageError('x', 429)), true);
		assert.equal(isRetryableStorageError(new StorageError('x', 500)), true);
		assert.equal(isRetryableStorageError(new StorageError('x', 404)), false);
		assert.equal(isRetryableStorageError(new StorageError('x', 403)), false);
		assert.equal(isRetryableStorageError(new StorageError('x')), false);
		assert.equal(isRetryableStorageError(new TypeError('network')), true);
		assert.equal(isRetryableStorageError(new Error('random')), false);
	});

	it('backoff tăng dần và có trần', () => {
		const policy = { maxAttempts: 5, baseDelayMs: 100, maxDelayMs: 400, totalDelayBudgetMs: 1000 };
		assert.equal(backoffDelayMs(1, policy, () => 1), 100);
		assert.equal(backoffDelayMs(2, policy, () => 1), 200);
		assert.equal(backoffDelayMs(3, policy, () => 1), 400);
		assert.equal(backoffDelayMs(9, policy, () => 1), 400, 'phải có trần');
		// jitter: giá trị trong [0.5, 1.0] × delay gốc
		assert.equal(backoffDelayMs(1, policy, () => 0), 50);
	});

	it('CircuitBreaker đếm failure và có retryAfterSeconds', () => {
		let now = 0;
		const breaker = new CircuitBreaker({ failureThreshold: 1, resetTimeoutMs: 5000, now: () => now });
		assert.equal(breaker.getState(), 'closed');
		assert.equal(breaker.retryAfterSeconds(), 0);
		return breaker
			.execute(async () => {
				throw new StorageError('x', 503);
			})
			.catch(() => {
				assert.equal(breaker.getState(), 'open');
				assert.equal(breaker.getFailureCount(), 1);
				assert.equal(breaker.retryAfterSeconds(), 5);
				now += 6000;
				assert.equal(breaker.getState(), 'half-open');
			});
	});
});
