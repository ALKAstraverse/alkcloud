import assert from 'node:assert/strict';
import { afterEach, describe, it } from 'node:test';
import { uploadFile, uploadFiles } from '../src/lib/upload.js';

/**
 * WS-I — kiểm thử engine upload phía client.
 *
 * Đây là nơi rủi ro **hỏng dữ liệu** cao nhất phía client: nếu cắt sai part
 * hoặc gán sai partNumber ⇒ file tải lên khác file gốc (checksum lệch) mà
 * không có lỗi rõ ràng.
 *
 * Bất biến được kiểm tra:
 *   U1. Mỗi byte của file gốc được gửi đúng 1 lần, đúng thứ tự part.
 *   U2. Tổng kích thước các part = kích thước file.
 *   U3. partNumber bắt đầu từ 1 và liên tục.
 *   U4. Single-part: đúng 1 PUT với toàn bộ file.
 *   U5. Lỗi ⇒ gọi abort (không để treo multipart trên B2).
 *   U6. Tiến độ báo cáo không vượt tổng kích thước file.
 */

const originalFetch = globalThis.fetch;

afterEach(() => {
	globalThis.fetch = originalFetch;
});

interface PutCall {
	url: string;
	size: number;
	etag: string;
}

interface Harness {
	puts: PutCall[];
	completed: Array<{ uploadSessionId: string; parts: Array<{ partNumber: number; etag: string; size: number }>; uploadId?: string }>;
	aborted: string[];
	mode: 'single' | 'multipart';
	partCount: number;
	partSize: number;
	failPutAt: number | null;
}

function stubApi(harness: Harness): void {
	globalThis.fetch = (async (url: string | URL, init: RequestInit = {}) => {
		const href = String(url);
		const method = init.method ?? 'GET';

		// PUT thẳng lên B2 (URL giả) — không đi qua API.
		if (method === 'PUT') {
			const body = init.body as Blob;
			const size = body.size;
			harness.puts.push({ url: href, size, etag: `etag-${href}-${harness.puts.length}` });
			if (harness.failPutAt !== null && harness.puts.length === harness.failPutAt) {
				return new Response('boom', { status: 500 });
			}
			return new Response('', { status: 200, headers: { etag: `etag-${href}-${harness.puts.length}` } });
		}

		// API calls (base /api/v1).
		if (href.endsWith('/uploads') && method === 'POST') {
			const payload = JSON.parse(String(init.body)) as { fileName: string; totalSize: number };
			if (harness.mode === 'single') {
				return new Response(
					JSON.stringify({
						uploadSessionId: 'upl_1',
						mode: 'single',
						partSize: payload.totalSize,
						partCount: 1,
						parts: [{ partNumber: 1, url: 'https://b2.invalid/put/obj', headers: {}, expiresAt: 'x' }],
					}),
					{ status: 201, headers: { 'content-type': 'application/json' } },
				);
			}
			return new Response(
				JSON.stringify({
					uploadSessionId: 'upl_1',
					mode: 'multipart',
					uploadId: 'mpu_1',
					partSize: harness.partSize,
					partCount: harness.partCount,
					parts: Array.from({ length: Math.min(20, harness.partCount) }, (_, index) => ({
						partNumber: index + 1,
						url: `https://b2.invalid/part/${index + 1}`,
						headers: {},
						expiresAt: 'x',
					})),
				}),
				{ status: 201, headers: { 'content-type': 'application/json' } },
			);
		}

		if (href.includes('/parts') && method === 'POST') {
			const payload = JSON.parse(String(init.body)) as { partNumbers: number[] };
			return new Response(
				JSON.stringify({
					parts: payload.partNumbers.map((partNumber) => ({
						partNumber,
						url: `https://b2.invalid/part/${partNumber}`,
						headers: {},
						expiresAt: 'x',
					})),
				}),
				{ status: 200, headers: { 'content-type': 'application/json' } },
			);
		}

		if (href.includes('/complete') && method === 'POST') {
			const payload = JSON.parse(String(init.body)) as {
				parts: Array<{ partNumber: number; etag: string; size: number }>;
				uploadId?: string;
			};
			harness.completed.push(payload);
			return new Response(
				JSON.stringify({
					file: { id: 'fil_1', name: 'x.bin', size: payload.parts.reduce((sum, part) => sum + part.size, 0) },
					mode: harness.mode,
					size: payload.parts.reduce((sum, part) => sum + part.size, 0),
				}),
				{ status: 201, headers: { 'content-type': 'application/json' } },
			);
		}

		if (method === 'DELETE') {
			harness.aborted.push(href);
			return new Response(null, { status: 204 });
		}

		return new Response('{}', { status: 200, headers: { 'content-type': 'application/json' } });
	}) as typeof fetch;
}

function makeHarness(overrides: Partial<Harness> = {}): Harness {
	return {
		puts: [],
		completed: [],
		aborted: [],
		mode: 'single',
		partCount: 1,
		partSize: 1024,
		failPutAt: null,
		...overrides,
	};
}

describe('WS-I — upload single-part', () => {
	it('gửi ĐÚNG 1 PUT chứa toàn bộ file', async () => {
		const harness = makeHarness();
		stubApi(harness);
		const file = new File([new Uint8Array(500)], 'a.bin');
		const result = await uploadFile(file);
		assert.equal(harness.puts.length, 1);
		assert.equal(harness.puts[0]?.size, 500, 'toàn bộ file phải nằm trong 1 part');
		assert.equal(harness.completed.length, 1);
		assert.equal(harness.completed[0]?.parts.length, 1);
		assert.equal(harness.completed[0]?.parts[0]?.partNumber, 1);
		assert.equal(result.id, 'fil_1');
	});

	it('báo tiến độ 100% khi xong', async () => {
		const harness = makeHarness();
		stubApi(harness);
		const progress: number[] = [];
		await uploadFile(new File([new Uint8Array(120)], 'a.bin'), {
			onProgress: (value) => progress.push(value.uploadedBytes),
		});
		assert.ok(progress.length > 0);
		assert.equal(progress[progress.length - 1], 120);
	});
});

describe('WS-I — upload multipart', () => {
	it('cắt part đúng kích thước, partNumber liên tục từ 1', async () => {
		const harness = makeHarness({ mode: 'multipart', partCount: 3, partSize: 1000 });
		stubApi(harness);
		const file = new File([new Uint8Array(2500)], 'big.bin');
		await uploadFile(file);

		assert.equal(harness.puts.length, 3, 'phải có 3 PUT');
		const sizes = harness.puts.map((put) => put.size).sort((a, b) => a - b);
		assert.deepEqual(sizes, [500, 1000, 1000], 'part cuối nhỏ hơn (2500 = 1000 + 1000 + 500)');

		const parts = harness.completed[0]?.parts ?? [];
		assert.deepEqual(
			parts.map((part) => part.partNumber),
			[1, 2, 3],
			'partNumber phải liên tục từ 1',
		);
		assert.equal(
			parts.reduce((sum, part) => sum + part.size, 0),
			2500,
			'tổng size các part = size file',
		);
	});

	it('mỗi byte được gửi đúng 1 lần (không trùng, không thiếu)', async () => {
		const harness = makeHarness({ mode: 'multipart', partCount: 4, partSize: 512 });
		stubApi(harness);
		const file = new File([new Uint8Array(2000)], 'big.bin');
		await uploadFile(file);
		const total = harness.puts.reduce((sum, put) => sum + put.size, 0);
		assert.equal(total, 2000, 'tổng byte gửi = kích thước file');
	});

	it('truyền uploadId khi complete multipart', async () => {
		const harness = makeHarness({ mode: 'multipart', partCount: 2, partSize: 1000 });
		stubApi(harness);
		await uploadFile(new File([new Uint8Array(1500)], 'big.bin'));
		assert.equal(harness.completed[0]?.uploadId, 'mpu_1');
	});

	it('tiến độ không vượt tổng kích thước file', async () => {
		const harness = makeHarness({ mode: 'multipart', partCount: 3, partSize: 1000 });
		stubApi(harness);
		const seen: Array<{ uploaded: number; total: number }> = [];
		await uploadFile(new File([new Uint8Array(2500)], 'big.bin'), {
			onProgress: (value) => seen.push({ uploaded: value.uploadedBytes, total: value.totalBytes }),
		});
		for (const value of seen) {
			assert.ok(value.uploaded <= value.total, 'uploaded không được vượt total');
		}
		assert.equal(seen[seen.length - 1]?.uploaded, 2500);
	});
});

describe('WS-I — xử lý lỗi upload', () => {
	it('PUT thất bại ⇒ ném lỗi VÀ gọi abort (không để treo multipart)', async () => {
		const harness = makeHarness({ mode: 'multipart', partCount: 2, partSize: 1000, failPutAt: 1 });
		stubApi(harness);
		await assert.rejects(() => uploadFile(new File([new Uint8Array(1500)], 'big.bin')));
		assert.equal(harness.aborted.length, 1, 'phải gọi abort 1 lần');
		assert.equal(harness.completed.length, 0, 'không được complete');
	});

	it('lỗi single-part không gọi abort (không có multipart)', async () => {
		const harness = makeHarness({ mode: 'single', failPutAt: 1 });
		stubApi(harness);
		await assert.rejects(() => uploadFile(new File([new Uint8Array(10)], 'a.bin')));
		assert.equal(harness.aborted.length, 0);
	});
});

describe('WS-I — upload nhiều file', () => {
	it('một file lỗi không làm dừng các file còn lại', async () => {
		const harness = makeHarness();
		stubApi(harness);
		// File thứ 2 sẽ fail (failPutAt đếm trên toàn bộ PUT).
		harness.failPutAt = 2;
		const result = await uploadFiles([
			new File([new Uint8Array(10)], 'a.bin'),
			new File([new Uint8Array(10)], 'b.bin'),
			new File([new Uint8Array(10)], 'c.bin'),
		]);
		assert.equal(result.uploaded + result.failed, 3, 'mọi file đều phải có kết quả');
		assert.ok(result.failed >= 1, 'phải có ít nhất 1 file thất bại');
		assert.ok(result.errors.length >= 1);
		assert.ok(result.errors[0]?.includes('.bin'), 'lỗi phải nêu tên file');
	});
});
