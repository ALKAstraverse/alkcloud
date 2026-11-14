import assert from 'node:assert/strict';
import { pbkdf2Sync } from 'node:crypto';
import { describe, it } from 'node:test';
import {
	AUTH_KEY_LENGTH,
	DEFAULT_KDF_PARAMS,
	SHARE_VERIFIER_CONTEXT,
	base64UrlToBytes,
	bytesToBase64Url,
	deriveAuthKey,
	deriveShareVerifier,
	parseKdfParams,
	randomSalt,
} from '../src/lib/kdf.js';

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
 *   - `authKey` phải KHỚP chuẩn PBKDF2-HMAC-SHA256 (so với `node:crypto`) —
 *     server chỉ so sánh `SHA-256(authKey + pepper)` nên lệch 1 byte là hỏng.
 */

describe('WS-I — KDF helpers', () => {
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

	it('parseKdfParams: thiếu/hỏng JSON ⇒ dùng mặc định', () => {
		assert.deepEqual(parseKdfParams(null), DEFAULT_KDF_PARAMS);
		assert.deepEqual(parseKdfParams(''), DEFAULT_KDF_PARAMS);
		assert.deepEqual(parseKdfParams('{không phải JSON'), DEFAULT_KDF_PARAMS);
		assert.deepEqual(parseKdfParams('{}'), DEFAULT_KDF_PARAMS);
	});

	it('parseKdfParams: đọc được giá trị hợp lệ', () => {
		const parsed = parseKdfParams(
			JSON.stringify({ algo: 'pbkdf2', hash: 'sha-256', iterations: 210_000, outputLength: 32 }),
		);
		assert.equal(parsed.algo, 'pbkdf2');
		assert.equal(parsed.iterations, 210_000);
		assert.equal(parsed.outputLength, 32);
	});

	it('parseKdfParams: kẹp iterations vào dải an toàn', () => {
		assert.equal(parseKdfParams(JSON.stringify({ algo: 'pbkdf2', iterations: 1 })).iterations, 100_000);
		assert.equal(parseKdfParams(JSON.stringify({ algo: 'pbkdf2', iterations: 99_999_999 })).iterations, 2_000_000);
	});

	it('parseKdfParams: tham số Argon2 cũ ⇒ ném lỗi rõ ràng (không derive sai)', () => {
		assert.throws(
			() => parseKdfParams(JSON.stringify({ memorySize: 19_456, iterations: 2 })),
			/thuật toán băm cũ/,
		);
	});

	it('deriveAuthKey: khớp chuẩn PBKDF2-HMAC-SHA256 (node:crypto làm chuẩn)', async () => {
		const salt = randomSalt();
		const password = 'mật khẩu thử nghiệm';
		const derived = await deriveAuthKey(password, salt, {
			...DEFAULT_KDF_PARAMS,
			iterations: 10_000,
		});
		const expected = pbkdf2Sync(password, base64UrlToBytes(salt), 10_000, 32, 'sha256');
		assert.equal(derived.authKey, bytesToBase64Url(new Uint8Array(expected)));
		assert.equal(derived.authKey.length, AUTH_KEY_LENGTH);
		assert.equal(derived.authVerifierSalt, salt);
	});

	it('deriveAuthKey: tất định — cùng mật khẩu + salt ⇒ cùng authKey', async () => {
		const salt = randomSalt();
		const first = await deriveAuthKey('abc', salt, { ...DEFAULT_KDF_PARAMS, iterations: 10_000 });
		const second = await deriveAuthKey('abc', salt, { ...DEFAULT_KDF_PARAMS, iterations: 10_000 });
		assert.equal(first.authKey, second.authKey);
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
