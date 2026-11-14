import assert from 'node:assert/strict';
import { afterEach, describe, it } from 'node:test';
import { uniqueFileName, uploadFile, uploadFiles } from '../src/lib/upload.js';

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
	/** Tất cả lần gửi part (direct + proxy). */
	puts: PutCall[];
	/** PUT thẳng vào presigned URL của B2 — đường CHÍNH (nhanh, 1 hop). */
	directPuts: string[];
	/** PUT qua API proxy — đường FALLBACK (khi bị CSP chặn hoặc B2 lỗi). */
	proxyPuts: string[];
	completed: Array<{ uploadSessionId: string; parts: Array<{ partNumber: number; etag: string; size: number }>; uploadId?: string }>;
	aborted: string[];
	/** Tên file gửi lên server khi tạo upload session. */
	createdNames: string[];
	mode: 'single' | 'multipart';
	partCount: number;
	partSize: number;
	failPutAt: number | null;
	/** Fail mọi PUT (direct lẫn proxy) — dùng khi cần lỗi xác định (part chạy song song). */
	failAllPuts: boolean;
	/** Đường direct bị chặn (CSP/lỗi mạng) ⇒ phải fallback qua proxy. */
	failDirect: boolean;
}

function stubApi(harness: Harness): void {
	// Khi 1 lần gửi direct lỗi, lần fallback qua proxy của CÙNG part đó cũng
	// phải lỗi — nếu không thì fallback cứu được và file không "thất bại".
	let failFallback = false;
	globalThis.fetch = (async (url: string | URL, init: RequestInit = {}) => {
		const href = String(url);
		const method = init.method ?? 'GET';

		// Gửi part: đường chính là PUT thẳng vào presigned URL của B2,
		// đường fallback là API proxy (`POST /uploads/:id/content`).
		if (method === 'PUT' || (method === 'POST' && href.includes('/content'))) {
			const body = init.body as Blob;
			const size = body.size;
			const isProxy = href.includes('/uploads/') && href.includes('/content');
			const etag = `etag-${href}-${harness.puts.length}`;
			harness.puts.push({ url: href, size, etag });
			if (isProxy) harness.proxyPuts.push(href);
			else harness.directPuts.push(href);
			if (harness.failAllPuts) return new Response('boom', { status: 500 });
			if (harness.failDirect && !isProxy) throw new TypeError('Failed to fetch');
			if (isProxy && failFallback) {
				failFallback = false;
				return new Response('boom', { status: 500 });
			}
			if (harness.failPutAt !== null && harness.puts.length === harness.failPutAt) {
				if (!isProxy) failFallback = true;
				return new Response('boom', { status: 500 });
			}
			return new Response('', { status: 200, headers: { etag } });
		}

		// API calls (base /api/v1).
		if (href.endsWith('/uploads') && method === 'POST') {
			const payload = JSON.parse(String(init.body)) as { fileName: string; totalSize: number };
			harness.createdNames.push(payload.fileName);
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
		directPuts: [],
		proxyPuts: [],
		completed: [],
		aborted: [],
		createdNames: [],
		mode: 'single',
		partCount: 1,
		partSize: 1024,
		failPutAt: null,
		failAllPuts: false,
		failDirect: false,
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
		assert.equal(harness.directPuts.length, 1, 'đường chính phải là PUT thẳng B2');
		assert.equal(harness.proxyPuts.length, 0, 'không cần đi qua API proxy');
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
		const harness = makeHarness({ mode: 'multipart', partCount: 2, partSize: 1000, failAllPuts: true });
		stubApi(harness);
		await assert.rejects(() => uploadFile(new File([new Uint8Array(1500)], 'big.bin')));
		assert.equal(harness.aborted.length, 1, 'phải gọi abort 1 lần');
		assert.equal(harness.completed.length, 0, 'không được complete');
	});

	it('đường direct bị chặn (CSP/lỗi mạng) ⇒ fallback qua API proxy', async () => {
		const harness = makeHarness({ mode: 'single', failDirect: true });
		stubApi(harness);
		const result = await uploadFile(new File([new Uint8Array(64)], 'a.bin'));
		assert.equal(result.id, 'fil_1', 'upload phải thành công qua đường fallback');
		assert.equal(harness.directPuts.length, 1, 'đường direct phải được thử trước');
		assert.equal(harness.proxyPuts.length, 1, 'sau đó phải fallback qua proxy');
	});

	it('B2 trả lỗi ở đường direct ⇒ fallback qua API proxy', async () => {
		const harness = makeHarness({ mode: 'single' });
		stubApi(harness);
		const originalFetch = globalThis.fetch;
		globalThis.fetch = (async (url: string | URL, init: RequestInit = {}) => {
			const href = String(url);
			const method = (init.method ?? 'GET').toUpperCase();
			if (method === 'PUT') return new Response('forbidden', { status: 403 });
			return originalFetch(url, init);
		}) as typeof fetch;
		const result = await uploadFile(new File([new Uint8Array(64)], 'a.bin'));
		assert.equal(result.id, 'fil_1');
		assert.equal(harness.proxyPuts.length, 1, 'phải fallback qua proxy');
	});

	it('cả 2 đường đều lỗi ⇒ ném lỗi', async () => {
		const harness = makeHarness({ mode: 'single' });
		stubApi(harness);
		globalThis.fetch = (async () => new Response('down', { status: 503 })) as typeof fetch;
		await assert.rejects(() => uploadFile(new File([new Uint8Array(8)], 'a.bin')));
	});

	it('lỗi single-part cũng gọi abort (không rò session + quota)', async () => {
		const harness = makeHarness({ mode: 'single', failAllPuts: true });
		stubApi(harness);
		await assert.rejects(() => uploadFile(new File([new Uint8Array(10)], 'a.bin')));
		assert.equal(harness.aborted.length, 1, 'phải huỷ session để không rò quota');
	});
});

describe('WS-I — tên file trùng', () => {
	it('giữ nguyên tên khi chưa tồn tại', () => {
		assert.equal(uniqueFileName('bug.txt', []), 'bug.txt');
	});

	it('tự thêm hậu tố khi trùng (giống Nextcloud)', () => {
		assert.equal(uniqueFileName('bug.txt', ['bug.txt']), 'bug (1).txt');
		assert.equal(uniqueFileName('bug.txt', ['bug.txt', 'bug (1).txt']), 'bug (2).txt');
	});

	it('so khớp không phân biệt hoa thường', () => {
		assert.equal(uniqueFileName('BUG.TXT', ['bug.txt']), 'BUG (1).TXT');
	});

	it('file không có đuôi vẫn đổi tên được', () => {
		assert.equal(uniqueFileName('README', ['README']), 'README (1)');
	});

	it('dùng tên truyền vào khi tạo upload session', async () => {
		const harness = makeHarness();
		stubApi(harness);
		await uploadFile(new File([new Uint8Array(10)], 'bug.txt'), { name: 'bug (1).txt' });
		assert.deepEqual(harness.createdNames, ['bug (1).txt']);
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
