import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import {
	AUTH_KEY_LENGTH,
	DEFAULT_ARGON2_PARAMS,
	SHARE_VERIFIER_CONTEXT,
	base64UrlToBytes,
	bytesToBase64Url,
	deriveShareVerifier,
	parseArgon2Params,
	randomSalt,
} from '../src/lib/argon2.js';

/**
 * WS-I — kiểm thử logic client.
 *
 * Mục tiêu: khóa lại các bất biến mà server **không** kiểm tra được vì client
 * là nơi tính toán:
 *   - verifier của mật khẩu share phải TẤT ĐỊNH và đúng định dạng (server so
 *     sánh bằng `timingSafeEqual` với hash ⇒ sai 1 byte là hỏng).
 *   - base64url phải round-trip đúng (salt dùng chung giữa lúc đăng ký và lúc
 *     đăng nhập).
 *   - salt phải NGẪU NHIÊN (2 lần gọi khác nhau).
 */

describe('WS-I — argon2 helpers', () => {
	it('base64url round-trip đúng với byte ngẫu nhiên', () => {
		for (const length of [1, 16, 32, 64]) {
			const bytes = new Uint8Array(length);
			for (let index = 0; index < length; index++) bytes[index] = (index * 37 + 11) % 256;
			const encoded = bytesToBase64Url(bytes);
			assert.ok(!encoded.includes('+'), 'base64url không được chứa +');
			assert.ok(!encoded.includes('/'), 'base64url không được chứa /');
			assert.ok(!encoded.includes('='), 'base64url không được chứa padding');
			assert.deepEqual([...base64UrlToBytes(encoded)], [...bytes]);
		}
	});

	it('randomSalt trả base64url đúng độ dài và NGẪU NHIÊN', () => {
		const salt = randomSalt();
		assert.equal(salt.length, 22, '16 byte base64url = 22 ký tự');
		assert.ok(/^[A-Za-z0-9_-]+$/.test(salt), 'salt phải là base64url');
		const other = randomSalt();
		assert.notEqual(salt, other, '2 lần gọi phải khác nhau');
	});

	it('authKey dài 43 ký tự (base64url của 32 byte)', () => {
		assert.equal(bytesToBase64Url(new Uint8Array(32)).length, AUTH_KEY_LENGTH);
	});

	it('parseArgon2Params: thiếu/thắm JSON ⇒ dùng mặc định', () => {
		assert.deepEqual(parseArgon2Params(null), DEFAULT_ARGON2_PARAMS);
		assert.deepEqual(parseArgon2Params(''), DEFAULT_ARGON2_PARAMS);
		assert.deepEqual(parseArgon2Params('{không phải JSON'), DEFAULT_ARGON2_PARAMS);
		assert.deepEqual(parseArgon2Params('{}'), DEFAULT_ARGON2_PARAMS);
	});

	it('parseArgon2Params: đọc được giá trị hợp lệ', () => {
		const parsed = parseArgon2Params(JSON.stringify({ memorySize: 1024, iterations: 3 }));
		assert.equal(parsed.memorySize, 1024);
		assert.equal(parsed.iterations, 3);
		assert.equal(parsed.parallelism, DEFAULT_ARGON2_PARAMS.parallelism);
		assert.equal(parsed.outputLength, DEFAULT_ARGON2_PARAMS.outputLength);
	});
});

describe('WS-I — verifier mật khẩu share', () => {
	it('TẤT ĐỊNH: cùng mật khẩu ⇒ cùng verifier', async () => {
		const first = await deriveShareVerifier('mật khẩu của tôi');
		const second = await deriveShareVerifier('mật khẩu của tôi');
		assert.equal(first, second, 'verifier phải tất định');
	});

	it('khác mật khẩu ⇒ khác verifier', async () => {
		const first = await deriveShareVerifier('abc');
		const second = await deriveShareVerifier('abd');
		assert.notEqual(first, second);
	});

	it('định dạng đúng: 64 ký tự hex thường (không phải base64url)', async () => {
		const verifier = await deriveShareVerifier('x');
		assert.match(verifier, /^[0-9a-f]{64}$/, 'server yêu cầu /^[0-9a-f]{64}$/');
	});

	it('có context prefix ⇒ cùng mật khẩu với context khác cho kết quả khác', async () => {
		const verifier = await deriveShareVerifier('abc');
		// Chứng minh verifier KHÔNG phải SHA-256(mật khẩu) thuần.
		const plain = await crypto.subtle.digest('SHA-256', new TextEncoder().encode('abc'));
		const plainHex = Array.from(new Uint8Array(plain))
			.map((byte) => byte.toString(16).padStart(2, '0'))
			.join('');
		assert.notEqual(verifier, plainHex);
		assert.ok(SHARE_VERIFIER_CONTEXT.length > 0);
	});

	it('mật khẩu rỗng vẫn tạo verifier hợp lệ (server mới chặn)', async () => {
		const verifier = await deriveShareVerifier('');
		assert.match(verifier, /^[0-9a-f]{64}$/);
	});
});
