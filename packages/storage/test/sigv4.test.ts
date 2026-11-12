import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { SignatureV4 } from '@smithy/signature-v4';
import { HttpRequest } from '@smithy/protocol-http';
import { Sha256 } from '@aws-crypto/sha256-js';
import {
	canonicalQueryString,
	canonicalUri,
	encodeRfc3986,
	presignUrl,
	signRequest,
} from '@alkcloud/storage';
import { B2Storage, extractXmlValues } from '@alkcloud/storage';

// Credential giả CỐ Ý không trùng mẫu AWS doc (`AKIA...EXAMPLE`) để không bị
// secret scanner của CI báo nhầm. SigV4 coi key là chuỗi bất kỳ ⇒ không ảnh
// hưởng tính đúng của test.
const CONFIG = {
	accessKeyId: 'TESTACCESSKEYID01',
	secretAccessKey: 'test-secret-access-key-not-a-real-credential',
	region: 'us-west-004',
	service: 's3',
};

const ENDPOINT = 'https://s3.us-west-004.backblazeb2.com';
const FIXED_NOW = new Date('2026-01-15T10:30:00.000Z');

describe('canonical helpers', () => {
	it('encodeRfc3986 escape ký tự đặc biệt', () => {
		assert.equal(encodeRfc3986('a b'), 'a%20b');
		assert.equal(encodeRfc3986("a!b'c(d)e*f"), 'a%21b%27c%28d%29e%2Af');
	});

	it('canonicalUri giữ dấu / và escape segment', () => {
		assert.equal(canonicalUri('/bucket/key'), '/bucket/key');
		assert.equal(canonicalUri('bucket/key'), '/bucket/key');
		assert.equal(canonicalUri('/bucket/a b.txt'), '/bucket/a%20b.txt');
	});

	it('canonicalQueryString sort key và encode', () => {
		assert.equal(canonicalQueryString({ b: '2', a: '1' }), 'a=1&b=2');
		assert.equal(canonicalQueryString({ 'X-Amz-Expires': '300' }), 'X-Amz-Expires=300');
	});
});

describe('SigV4 header signing khớp AWS SDK', () => {
	it('Authorization header giống @smithy/signature-v4', async () => {
		const method = 'GET';
		const path = '/bucket/objects/file.txt';
		const headers = { 'content-type': 'text/plain' };

		// smithy ký hash của body rỗng; dùng cùng giá trị để so sánh byte-for-byte.
		const emptyPayloadHash = 'e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855';
		const ours = await signRequest(CONFIG, {
			method,
			endpoint: ENDPOINT,
			path,
			headers,
			payloadHash: emptyPayloadHash,
			now: FIXED_NOW,
		});

		const signer = new SignatureV4({
			credentials: { accessKeyId: CONFIG.accessKeyId, secretAccessKey: CONFIG.secretAccessKey },
			region: CONFIG.region,
			service: CONFIG.service,
			sha256: Sha256,
		});
		const signed = await signer.sign(
			new HttpRequest({
				method,
				protocol: 'https:',
				hostname: 's3.us-west-004.backblazeb2.com',
				path,
				headers: { ...headers, host: 's3.us-west-004.backblazeb2.com' },
			}),
			{ signingDate: FIXED_NOW },
		);

		assert.equal(ours.headers.Authorization, signed.headers.authorization);
	});

	it('presigned URL có đủ tham số SigV4 và TTL <= 5 phút', async () => {
		const result = await presignUrl(CONFIG, {
			method: 'PUT',
			endpoint: ENDPOINT,
			path: '/bucket/objects/file.txt',
			expiresInSeconds: 300,
			now: FIXED_NOW,
		});
		const url = new URL(result.url);
		assert.equal(url.searchParams.get('X-Amz-Algorithm'), 'AWS4-HMAC-SHA256');
		assert.equal(url.searchParams.get('X-Amz-Expires'), '300');
		assert.equal(url.searchParams.get('X-Amz-SignedHeaders'), 'host');
		assert.match(url.searchParams.get('X-Amz-Credential') ?? '', new RegExp(`^${CONFIG.accessKeyId}/\\d{8}/${CONFIG.region}/s3/aws4_request$`));
		assert.match(url.searchParams.get('X-Amz-Signature') ?? '', /^[0-9a-f]{64}$/);
		assert.equal(result.expiresAt, '2026-01-15T10:35:00.000Z');
	});

	it('presigned URL ký chỉ header host (client không cần header phụ)', async () => {
		const result = await presignUrl(CONFIG, {
			method: 'PUT',
			endpoint: ENDPOINT,
			path: '/bucket/objects/file.txt',
			now: FIXED_NOW,
		});
		assert.equal(new URL(result.url).searchParams.get('X-Amz-SignedHeaders'), 'host');
	});

	it('URL presign khác nhau theo path và theo thời gian', async () => {
		const a = await presignUrl(CONFIG, { method: 'PUT', endpoint: ENDPOINT, path: '/bucket/a', now: FIXED_NOW });
		const b = await presignUrl(CONFIG, { method: 'PUT', endpoint: ENDPOINT, path: '/bucket/b', now: FIXED_NOW });
		const c = await presignUrl(CONFIG, {
			method: 'PUT',
			endpoint: ENDPOINT,
			path: '/bucket/a',
			now: new Date('2026-01-15T10:31:00.000Z'),
		});
		assert.notEqual(a.url, b.url);
		assert.notEqual(a.url, c.url);
	});
});

describe('Phase 2 storage regressions', () => {
	it('presign đưa X-Amz-Content-Sha256 vào query, không trả header x-amz-*', async () => {
		const result = await presignUrl(CONFIG, {
			method: 'PUT',
			endpoint: ENDPOINT,
			path: '/bucket/objects/fil_abc/rev-1',
			now: FIXED_NOW,
			expiresInSeconds: 300,
			headers: { 'content-type': 'text/plain' },
		});
		const url = new URL(result.url);
		assert.equal(url.searchParams.get('X-Amz-Content-Sha256'), 'UNSIGNED-PAYLOAD');
		assert.equal(url.searchParams.get('X-Amz-SignedHeaders'), 'host');
		assert.equal(url.searchParams.get('X-Amz-Expires'), '300');
		// Client chỉ gửi header nghiệp vụ, không gửi lại header x-amz-*.
		assert.deepEqual(result.headers, { 'content-type': 'text/plain' });
	});

	it('signRequest ký payload hash thật của body (không phải UNSIGNED-PAYLOAD)', async () => {
		const signed = await signRequest(CONFIG, {
			method: 'POST',
			endpoint: ENDPOINT,
			path: '/bucket/objects/fil_abc/rev-1',
			query: { uploads: '' },
			now: FIXED_NOW,
			body: '<CompleteMultipartUpload></CompleteMultipartUpload>',
		});
		const payloadHash = signed.headers['x-amz-content-sha256'];
		assert.ok(payloadHash);
		assert.notEqual(payloadHash, 'UNSIGNED-PAYLOAD');
		assert.match(payloadHash, /^[0-9a-f]{64}$/);
		// Không body => sha256 chuỗi rỗng.
		const empty = await signRequest(CONFIG, {
			method: 'GET',
			endpoint: ENDPOINT,
			path: '/bucket/objects/fil_abc/rev-1',
			now: FIXED_NOW,
		});
		assert.equal(
			empty.headers['x-amz-content-sha256'],
			'e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855',
		);
	});

	it('canonicalUri không ném lỗi khi percent-encoding sai', () => {
		assert.doesNotThrow(() => canonicalUri('/bucket/100%.txt'));
		assert.equal(canonicalUri('/bucket/a%2Fb'), '/bucket/a%252Fb'.replace('%252F', '%2F'));
	});

	it('signedFetch không nhân đôi query string (BUG-04)', async () => {
		const originalFetch = globalThis.fetch;
		const calls: string[] = [];
		globalThis.fetch = (async (input: RequestInfo | URL) => {
			calls.push(typeof input === 'string' ? input : input.toString());
			return new Response('<InitiateMultipartUploadResult><UploadId>u-1</UploadId></InitiateMultipartUploadResult>', {
				status: 200,
			});
		}) as typeof fetch;
		try {
			const storage = new B2Storage({
				endpoint: ENDPOINT,
				region: 'us-west-004',
				bucket: 'alkcloud',
				accessKeyId: CONFIG.accessKeyId,
				secretAccessKey: CONFIG.secretAccessKey,
			});
			const result = await storage.createMultipartUpload({ key: 'objects/fil_x/rev-y', contentType: 'text/plain' });
			assert.equal(result.uploadId, 'u-1');
			const url = new URL(calls[0]!);
			assert.equal(url.searchParams.getAll('uploads').length, 1);
			assert.equal(url.pathname, '/alkcloud/objects/fil_x/rev-y');
		} finally {
			globalThis.fetch = originalFetch;
		}
	});

	it('listObjectVersions dùng path bucket không có slash cuối', async () => {
		const originalFetch = globalThis.fetch;
		const calls: string[] = [];
		globalThis.fetch = (async (input: RequestInfo | URL) => {
			calls.push(typeof input === 'string' ? input : input.toString());
			return new Response('<ListVersionsResult></ListVersionsResult>', { status: 200 });
		}) as typeof fetch;
		try {
			const storage = new B2Storage({
				endpoint: ENDPOINT,
				region: 'us-west-004',
				bucket: 'alkcloud',
				accessKeyId: CONFIG.accessKeyId,
				secretAccessKey: CONFIG.secretAccessKey,
			});
			await storage.listObjectVersions('objects/fil_x/rev-y');
			const url = new URL(calls[0]!);
			assert.equal(url.pathname, '/alkcloud');
			assert.equal(url.searchParams.get('versions'), '');
			assert.equal(url.searchParams.get('prefix'), 'objects/fil_x/rev-y');
		} finally {
			globalThis.fetch = originalFetch;
		}
	});

	it('extractXmlValues giải mã XML entity đúng một lần (BUG-06)', () => {
		const values = extractXmlValues('<A>a &amp; b &lt;tag&gt; &quot;q&quot; &apos;s&apos;</A>', ['A']);
		assert.equal(values[0]?.value, 'a & b <tag> "q" \'s\'');
		// Entity lạ được giữ nguyên.
		const unknown = extractXmlValues('<A>x &bogus; y</A>', ['A']);
		assert.equal(unknown[0]?.value, 'x &bogus; y');
	});

	it('presignGet đưa response-content-type vào query', async () => {
		const originalFetch = globalThis.fetch;
		void originalFetch;
		const storage = new B2Storage({
			endpoint: ENDPOINT,
			region: 'us-west-004',
			bucket: 'alkcloud',
			accessKeyId: CONFIG.accessKeyId,
			secretAccessKey: CONFIG.secretAccessKey,
		});
		const target = await storage.presignGet({
			key: 'objects/fil_x/rev-y',
			responseContentType: 'application/pdf',
		});
		const url = new URL(target.url);
		assert.equal(url.searchParams.get('response-content-type'), 'application/pdf');
	});
});
