import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import {
	TOKEN_HEADER,
	TARGET_HEADER,
	constantTimeEqual,
	handleRelay,
	resolveTarget,
	type RelayEnv,
} from '../src/index.ts';

const ENV: RelayEnv = {
	B2_ALLOWED_HOST: 's3.ca-east-006.backblazeb2.com',
	B2_RELAY_TOKEN: 'relay-token-test',
};

function relayRequest(target: string, options: { token?: string | null; method?: string; headers?: Record<string, string> } = {}) {
	const headers = new Headers(options.headers ?? {});
	headers.set(TARGET_HEADER, target);
	if (options.token !== null) headers.set(TOKEN_HEADER, options.token ?? ENV.B2_RELAY_TOKEN);
	return new Request('https://alkcloud-b2relay.alkev.workers.dev/', {
		method: options.method ?? 'GET',
		headers,
	});
}

describe('b2relay: resolveTarget', () => {
	it('R1 chỉ chấp nhận https + đúng host', () => {
		assert.ok(resolveTarget('https://s3.ca-east-006.backblazeb2.com/bucket/key', ENV.B2_ALLOWED_HOST));
		assert.equal(resolveTarget('http://s3.ca-east-006.backblazeb2.com/bucket/key', ENV.B2_ALLOWED_HOST), null);
		assert.equal(resolveTarget('https://evil.example.com/bucket/key', ENV.B2_ALLOWED_HOST), null);
		assert.equal(resolveTarget('https://user:pass@s3.ca-east-006.backblazeb2.com/x', ENV.B2_ALLOWED_HOST), null);
		assert.equal(resolveTarget('not-a-url', ENV.B2_ALLOWED_HOST), null);
		assert.equal(resolveTarget(null, ENV.B2_ALLOWED_HOST), null);
	});
});

describe('b2relay: xác thực + chuyển tiếp', () => {
	it('R2 thiếu/sai token ⇒ 401, không gọi upstream', async () => {
		let called = 0;
		const fetchImpl = async () => {
			called += 1;
			return new Response('x');
		};
		const missing = await handleRelay(
			relayRequest('https://s3.ca-east-006.backblazeb2.com/bucket/key', { token: null }),
			ENV,
			fetchImpl,
		);
		assert.equal(missing.status, 401);
		const wrong = await handleRelay(
			relayRequest('https://s3.ca-east-006.backblazeb2.com/bucket/key', { token: 'sai' }),
			ENV,
			fetchImpl,
		);
		assert.equal(wrong.status, 401);
		assert.equal(called, 0);
	});

	it('R3 đích sai ⇒ 400, không gọi upstream', async () => {
		let called = 0;
		const fetchImpl = async () => {
			called += 1;
			return new Response('x');
		};
		const response = await handleRelay(relayRequest('https://evil.example.com/key'), ENV, fetchImpl);
		assert.equal(response.status, 400);
		assert.equal(called, 0);
	});

	it('R4 chuyển tiếp method/header/body + giữ host B2, bỏ header nội bộ', async () => {
		let seen: { url: string; init: RequestInit } | null = null;
		const fetchImpl = async (url: string, init: RequestInit) => {
			seen = { url, init };
			return new Response('ok', { status: 200, headers: { etag: '"abc"' } });
		};
		const request = relayRequest('https://s3.ca-east-006.backblazeb2.com/bucket/objects%2F1/rev?uploadId=x', {
			method: 'POST',
			headers: { authorization: 'AWS4-HMAC-SHA256 test', 'x-amz-date': '20261113T000000Z' },
		});
		const response = await handleRelay(request, ENV, fetchImpl);
		assert.equal(response.status, 200);
		assert.equal(response.headers.get('etag'), '"abc"');
		assert.ok(seen);
		const { url, init } = seen as { url: string; init: RequestInit };
		assert.equal(url, 'https://s3.ca-east-006.backblazeb2.com/bucket/objects%2F1/rev?uploadId=x');
		const headers = new Headers(init.headers);
		assert.equal(headers.get('host'), 's3.ca-east-006.backblazeb2.com');
		assert.equal(headers.get('authorization'), 'AWS4-HMAC-SHA256 test');
		assert.equal(headers.get(TOKEN_HEADER), null);
		assert.equal(headers.get(TARGET_HEADER), null);
		assert.equal(init.redirect, 'manual');
	});

	it('R5 HEAD/204 không trả body', async () => {
		const head = await handleRelay(
			relayRequest('https://s3.ca-east-006.backblazeb2.com/bucket/key', { method: 'HEAD' }),
			ENV,
			async () => new Response('ignored', { status: 200 }),
		);
		assert.equal(await head.text(), '');
		const empty = await handleRelay(
			relayRequest('https://s3.ca-east-006.backblazeb2.com/bucket/key', { method: 'DELETE' }),
			ENV,
			async () => new Response(null, { status: 204 }),
		);
		assert.equal(await empty.text(), '');
	});

	it('R6 /health công khai, không cần token', async () => {
		const response = await handleRelay(new Request('https://alkcloud-b2relay.alkev.workers.dev/health'), ENV, async () => {
			throw new Error('không được gọi upstream');
		});
		assert.equal(response.status, 200);
		const body = (await response.json()) as { status: string; service: string };
		assert.equal(body.status, 'ok');
		assert.equal(body.service, 'alkcloud-b2relay');
	});

	it('R7 constantTimeEqual đúng ngữ nghĩa', () => {
		assert.equal(constantTimeEqual('abc', 'abc'), true);
		assert.equal(constantTimeEqual('abc', 'abd'), false);
		assert.equal(constantTimeEqual('abc', 'ab'), false);
		assert.equal(constantTimeEqual('', ''), true);
	});
});
