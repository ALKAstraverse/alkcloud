import assert from 'node:assert/strict';
import { afterEach, describe, it } from 'node:test';
import { B2Storage } from '../src/index.ts';

/**
 * Worker gắn route zone `alk.xx.kg` fetch B2 trả 525 (đo thật 13/11/2026) ⇒
 * request do Worker gửi phải đi qua relay workers.dev, còn presigned URL thì
 * vẫn trỏ thẳng B2 để client tự gọi.
 */

const ENDPOINT = 'https://s3.ca-east-006.backblazeb2.com';
const REAL_FETCH = globalThis.fetch;

function makeStorage(proxy?: { url: string; token: string }) {
	return new B2Storage({
		endpoint: ENDPOINT,
		region: 'ca-east-006',
		bucket: 'alkcloud-storage',
		accessKeyId: 'key-id-test',
		secretAccessKey: 'secret-test',
		...(proxy ? { proxy } : {}),
	});
}

afterEach(() => {
	globalThis.fetch = REAL_FETCH;
});

describe('B2Storage proxy (525 workaround)', () => {
	it('P1 headObject đi qua relay: giữ header chữ ký + target + token', async () => {
		let seen: { url: string; init: RequestInit } | null = null;
		globalThis.fetch = (async (url: string, init: RequestInit) => {
			seen = { url, init };
			return new Response(null, { status: 200, headers: { 'content-length': '7', etag: '"e"' } });
		}) as typeof fetch;

		const stat = await makeStorage({ url: 'https://relay.example/relay', token: 'tok' }).headObject('objects/a/b');
		assert.equal(stat?.size, 7);
		assert.ok(seen);
		const { url, init } = seen as { url: string; init: RequestInit };
		assert.equal(url, 'https://relay.example/relay');
		const headers = new Headers(init.headers);
		assert.equal(headers.get('x-alkcloud-relay-token'), 'tok');
		assert.equal(
			headers.get('x-alkcloud-target'),
			'https://s3.ca-east-006.backblazeb2.com/alkcloud-storage/objects/a/b',
		);
		assert.match(headers.get('authorization') ?? '', /^AWS4-HMAC-SHA256 Credential=key-id-test\//);
		assert.equal(headers.get('x-amz-content-sha256') !== null, true);
		assert.equal(init.method, 'HEAD');
	});

	it('P2 DELETE/multipart cũng qua relay, body được giữ nguyên', async () => {
		let seen: { url: string; init: RequestInit } | null = null;
		globalThis.fetch = (async (url: string, init: RequestInit) => {
			seen = { url, init };
			return new Response('<CompleteMultipartUploadResult><ETag>"x"</ETag><Size>3</Size></CompleteMultipartUploadResult>', {
				status: 200,
			});
		}) as typeof fetch;

		const result = await makeStorage({ url: 'https://relay.example/relay', token: 'tok' }).completeMultipartUpload({
			key: 'objects/a/b',
			uploadId: 'u1',
			parts: [{ partNumber: 1, etag: 'e1', size: 3 }],
		});
		assert.equal(result.etag, '"x"');
		assert.ok(seen);
		const headers = new Headers((seen as { init: RequestInit }).init.headers);
		assert.match(headers.get('x-alkcloud-target') ?? '', /\?uploadId=u1$/);
		assert.equal(typeof (seen as { init: RequestInit }).init.body, 'string');
	});

	it('P3 presigned URL KHÔNG đi qua relay (client gọi thẳng B2)', async () => {
		const storage = makeStorage({ url: 'https://relay.example/relay', token: 'tok' });
		const target = await storage.presignGet({ key: 'objects/a/b' });
		assert.equal(new URL(target.url).host, 's3.ca-east-006.backblazeb2.com');
		assert.equal(target.url.includes('relay.example'), false);
		const put = await storage.presignPut({ key: 'objects/a/b', contentType: 'text/plain' });
		assert.equal(new URL(put.url).host, 's3.ca-east-006.backblazeb2.com');
	});

	it('P4 không cấu hình proxy ⇒ gọi thẳng B2 (test/CI, scripts Node)', async () => {
		let seenUrl = '';
		globalThis.fetch = (async (url: string) => {
			seenUrl = String(url);
			return new Response(null, { status: 200, headers: { 'content-length': '0' } });
		}) as typeof fetch;
		await makeStorage().headObject('objects/a/b');
		assert.equal(seenUrl.startsWith('https://s3.ca-east-006.backblazeb2.com/alkcloud-storage/'), true);
	});
});
