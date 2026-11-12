import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import {
	base64UrlDecode,
	base64UrlEncode,
	hmacHex,
	newId,
	randomToken,
	sha256Hex,
	timingSafeEqual,
} from '@alkcloud/core';

describe('sha256Hex', () => {
	it('khớp vector SHA-256 chuẩn', async () => {
		assert.equal(
			await sha256Hex('abc'),
			'ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad',
		);
		assert.equal(
			await sha256Hex(''),
			'e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855',
		);
	});

	it('ổn định với đầu vào Uint8Array', async () => {
		const bytes = new TextEncoder().encode('abc');
		assert.equal(await sha256Hex(bytes), await sha256Hex('abc'));
	});
});

describe('hmacHex', () => {
	it('ổn định và phụ thuộc secret', async () => {
		const a = await hmacHex('secret', 'data');
		const b = await hmacHex('secret', 'data');
		const c = await hmacHex('secret2', 'data');
		assert.equal(a, b);
		assert.notEqual(a, c);
		assert.match(a, /^[0-9a-f]{64}$/);
	});
});

describe('base64Url', () => {
	it('encode/decode round-trip', () => {
		const bytes = new Uint8Array([0, 1, 2, 250, 251, 252, 253, 254, 255]);
		const encoded = base64UrlEncode(bytes);
		assert.match(encoded, /^[A-Za-z0-9_-]+$/);
		assert.deepEqual([...base64UrlDecode(encoded)], [...bytes]);
	});

	it('không chứa padding', () => {
		assert.equal(base64UrlEncode(new Uint8Array([1])).includes('='), false);
	});
});

describe('randomToken', () => {
	it('khác nhau mỗi lần và đủ dài', () => {
		const a = randomToken(32);
		const b = randomToken(32);
		assert.notEqual(a, b);
		assert.ok(a.length >= 40);
	});
});

describe('newId', () => {
	it('có prefix và sortable', () => {
		const id = newId('fil');
		assert.match(id, /^fil_[0-9a-z]{9}[A-Za-z0-9_-]{10}$/);
	});
});

describe('timingSafeEqual', () => {
	it('so sánh đúng', () => {
		assert.equal(timingSafeEqual('abc', 'abc'), true);
		assert.equal(timingSafeEqual('abc', 'abd'), false);
		assert.equal(timingSafeEqual('abc', 'abcd'), false);
	});
});
