import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { API, ORIGIN, type Harness, createHarness } from './harness.js';

/**
 * WS-J — proxy upload qua API (`PUT /api/v1/uploads/:id/content`).
 *
 * Bối cảnh: CSP do Cloudflare **edge** đặt có thể chặn host B2 trong
 * `connect-src` ⇒ browser không PUT thẳng được vào presigned URL ⇒ upload
 * chết với "Failed to fetch". Đường thay thế: browser → API → relay → B2.
 *
 * Bất biến bảo mật của đường này:
 *   - API **tự ký** presigned URL từ `session.objectKey` ⇒ presigned URL
 *     (bearer credential) không bao giờ đi qua mạng từ browser → API, và không
 *     xuất hiện trong query string / log của Cloudflare.
 *   - Chế độ single-part vs multipart do **server** quyết định (`session.partCount`),
 *     không tin payload của client.
 *   - Multipart bắt buộc có `partNumber` hợp lệ + `uploadId`.
 *   - fail-closed khi thiếu cấu hình relay.
 */

const ENDPOINT = 'https://s3.ca-east-006.backblazeb2.com';
const BUCKET = 'alkcloud-storage';
const RELAY_URL = 'https://relay.test';
const RELAY_TOKEN = 'relay-token-0123456789';
const MULTIPART_THRESHOLD = 100 * 1024 * 1024;

async function setup(totalSize = 5) {
	const harness = await createHarness({
		env: {
			B2_ENDPOINT: ENDPOINT,
			B2_BUCKET: BUCKET,
			B2_RELAY_URL: RELAY_URL,
			B2_RELAY_TOKEN: RELAY_TOKEN,
		} as never,
	});
	const created = await harness.request('/uploads', {
		method: 'POST',
		body: { fileName: 'probe.txt', contentType: 'text/plain', totalSize, folderId: null },
	});
	assert.equal(created.status, 201);
	const payload = (await created.json()) as { uploadSessionId: string };
	const row = await harness.db.getUploadSession(payload.uploadSessionId);
	assert.ok(row, 'phải có upload session trong D1');
	return { harness, sessionId: payload.uploadSessionId, objectKey: row.objectKey, partCount: row.partCount };
}

async function putContent(
	harness: Harness,
	sessionId: string,
	query = '',
	body = 'hello',
	method: 'POST' | 'PUT' = 'POST',
): Promise<Response> {
	return harness.app.fetch(
		new Request(`${API}/uploads/${sessionId}/content${query}`, {
			method,
			headers: {
				origin: ORIGIN,
				cookie: harness.cookie,
				'x-alkcloud-csrf': harness.csrf,
				'content-type': 'text/plain',
			},
			body,
		}),
	);
}

describe('WS-J — proxy upload qua API', () => {
	it('single-part: forward sang relay, tự ký target, trả ETag về client', async () => {
		const { harness, sessionId, objectKey } = await setup();
		const originalFetch = globalThis.fetch;
		const calls: { url: string; init?: RequestInit }[] = [];
		globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
			calls.push({ url: String(input), init });
			return new Response(null, { status: 200, headers: { etag: '"etag-abc"' } });
		}) as typeof globalThis.fetch;
		try {
			const response = await putContent(harness, sessionId);
			assert.equal(response.status, 200);
			assert.equal(response.headers.get('etag'), '"etag-abc"');
			assert.equal(response.headers.get('access-control-expose-headers'), 'ETag');
			assert.equal(calls.length, 1);
			assert.equal(calls[0]?.url, RELAY_URL);
			const headers = calls[0]?.init?.headers as Record<string, string>;
			// Target do API tự ký từ `session.objectKey` (storage signer của harness).
			const target = headers['x-alkcloud-target'] ?? '';
			assert.ok(target.startsWith('https://mock.invalid/put/'), `target sai: ${target}`);
			assert.ok(target.includes(encodeURIComponent(objectKey)), 'target phải chứa objectKey của session');
			assert.equal(headers['x-alkcloud-relay-token'], RELAY_TOKEN);
			assert.equal(headers['content-type'], 'text/plain');
		} finally {
			globalThis.fetch = originalFetch;
		}
	});

	it('single-part: client KHÔNG cần gửi presigned URL (không target trong query)', async () => {
		const { harness, sessionId } = await setup();
		const originalFetch = globalThis.fetch;
		globalThis.fetch = (async () => new Response(null, { status: 200 })) as typeof globalThis.fetch;
		try {
			const response = await putContent(harness, sessionId);
			assert.equal(response.status, 200);
		} finally {
			globalThis.fetch = originalFetch;
		}
	});

	it('trả 404 khi session không tồn tại', async () => {
		const { harness } = await setup();
		const response = await putContent(harness, 'upl_khong_ton_tai');
		assert.equal(response.status, 404);
	});

	it('PUT vẫn được hỗ trợ (server-to-server)', async () => {
		const { harness, sessionId } = await setup();
		const originalFetch = globalThis.fetch;
		globalThis.fetch = (async () => new Response(null, { status: 200 })) as typeof globalThis.fetch;
		try {
			const response = await putContent(harness, sessionId, '', 'hello', 'PUT');
			assert.equal(response.status, 200);
		} finally {
			globalThis.fetch = originalFetch;
		}
	});

	it('multipart: thiếu partNumber/uploadId ⇒ 400', async () => {
		const { harness, sessionId, partCount } = await setup(MULTIPART_THRESHOLD + 1024);
		assert.ok(partCount > 1, 'session phải là multipart');
		const originalFetch = globalThis.fetch;
		let forwarded = 0;
		globalThis.fetch = (async () => {
			forwarded += 1;
			return new Response(null, { status: 200 });
		}) as typeof globalThis.fetch;
		try {
			const missingPart = await putContent(harness, sessionId, '?uploadId=mpu_1');
			assert.equal(missingPart.status, 400);
			const missingUploadId = await putContent(harness, sessionId, '?partNumber=1');
			assert.equal(missingUploadId.status, 400);
			assert.equal(forwarded, 0, 'không được forward khi thiếu tham số');
		} finally {
			globalThis.fetch = originalFetch;
		}
	});

	it('multipart: partNumber + uploadId hợp lệ ⇒ forward', async () => {
		const { harness, sessionId, partCount, objectKey } = await setup(MULTIPART_THRESHOLD + 1024);
		assert.ok(partCount > 1, 'session phải là multipart');
		const originalFetch = globalThis.fetch;
		const calls: { url: string; init?: RequestInit }[] = [];
		globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
			calls.push({ url: String(input), init });
			return new Response(null, { status: 200, headers: { etag: '"etag-part-1"' } });
		}) as typeof globalThis.fetch;
		try {
			const response = await putContent(harness, sessionId, '?partNumber=1&uploadId=mpu_1');
			assert.equal(response.status, 200);
			assert.equal(calls.length, 1);
			const headers = calls[0]?.init?.headers as Record<string, string>;
			const target = headers['x-alkcloud-target'] ?? '';
			assert.ok(target.startsWith('https://mock.invalid/part/'), `target sai: ${target}`);
			assert.ok(target.includes(encodeURIComponent(objectKey)), 'target phải chứa objectKey của session');
			assert.ok(target.endsWith('/1'), 'target phải chứa partNumber=1');
		} finally {
			globalThis.fetch = originalFetch;
		}
	});

	it('fail-closed khi thiếu cấu hình relay', async () => {
		const harness = await createHarness({
			env: {
				B2_ENDPOINT: ENDPOINT,
				B2_BUCKET: BUCKET,
			} as never,
		});
		const created = await harness.request('/uploads', {
			method: 'POST',
			body: { fileName: 'probe.txt', contentType: 'text/plain', totalSize: 5, folderId: null },
		});
		const payload = (await created.json()) as { uploadSessionId: string };
		const row = await harness.db.getUploadSession(payload.uploadSessionId);
		assert.ok(row);
		const response = await putContent(harness, payload.uploadSessionId);
		assert.equal(response.status, 503);
	});
});
