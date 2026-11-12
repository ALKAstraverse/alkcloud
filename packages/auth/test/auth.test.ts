import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import {
	MemoryRateLimiter,
	computeVerifier,
	formatRecoveryCode,
	generateRecoveryCodes,
	hashRecoveryCode,
	hashSessionToken,
	createSessionMaterial,
	parseCookies,
	serializeCookie,
	validateCsrfToken,
	validateOrigin,
	verifyAuthKey,
} from '@alkcloud/auth';

const PEPPER = 'test-pepper-value-0123456789';

describe('session cookie', () => {
	it('serialize có Secure/HttpOnly/SameSite', () => {
		const cookie = serializeCookie('__Secure-alk_session', 'token123');
		assert.match(cookie, /^__Secure-alk_session=token123;/);
		assert.match(cookie, /Secure/);
		assert.match(cookie, /HttpOnly/);
		assert.match(cookie, /SameSite=Lax/);
		assert.match(cookie, /Path=\//);
	});

	it('parse cookies giải mã URI và bỏ qua phần rác', () => {
		const cookies = parseCookies('a=1; b=hello%20world; broken; =empty');
		assert.equal(cookies.a, '1');
		assert.equal(cookies.b, 'hello world');
		assert.equal(cookies.broken, undefined);
	});

	it('parse null header trả object rỗng', () => {
		assert.deepEqual(parseCookies(null), {});
	});
});

describe('session material', () => {
	it('token ngẫu nhiên, hash ổn định', async () => {
		const material = createSessionMaterial();
		assert.match(material.sessionId, /^ses_/);
		assert.ok(material.csrfSecret.length >= 30);
		const hash = await hashSessionToken(material.token);
		assert.equal(hash, await hashSessionToken(material.token));
		assert.equal(hash.length, 64);
	});
});

describe('authKey verifier', () => {
	it('verify đúng/sai', async () => {
		const verifier = await computeVerifier('authKey-1234567890', PEPPER);
		assert.equal(await verifyAuthKey('authKey-1234567890', PEPPER, verifier), true);
		assert.equal(await verifyAuthKey('authKey-1234567891', PEPPER, verifier), false);
	});

	it('đổi pepper => verifier khác', async () => {
		const a = await computeVerifier('authKey-1234567890', PEPPER);
		const b = await computeVerifier('authKey-1234567890', `${PEPPER}x`);
		assert.notEqual(a, b);
	});
});

describe('recovery codes', () => {
	it('format chuẩn XXXX-XXXX-XXXX', () => {
		assert.equal(formatRecoveryCode('abcd1234ef56'), 'ABCD-1234-EF56');
	});

	it('mã sinh ra là duy nhất và hash ổn định', async () => {
		const codes = generateRecoveryCodes(PEPPER, 10);
		assert.equal(codes.length, 10);
		assert.equal(new Set(codes.map((c) => c.code)).size, 10);
		const hash = await hashRecoveryCode(codes[0]!.code, PEPPER);
		assert.equal(hash, await hashRecoveryCode(codes[0]!.code, PEPPER));
		assert.notEqual(hash, await hashRecoveryCode(codes[1]!.code, PEPPER));
	});

	it('hash không phụ thuộc định dạng nhập (gạch nối)', async () => {
		const withDash = await hashRecoveryCode('ABCD-1234-EF56', PEPPER);
		const without = await hashRecoveryCode('abcd1234ef56', PEPPER);
		assert.equal(withDash, without);
	});
});

describe('CSRF & Origin', () => {
	const policy = { allowedOrigins: ['https://cloud.alk.xx.kg'], enforce: true };

	it('GET không cần Origin/CSRF', () => {
		const request = new Request('https://api.alk.xx.kg/api/v1/files', { method: 'GET' });
		assert.equal(validateOrigin(request, policy).ok, true);
		assert.equal(validateCsrfToken(request, 'secret').ok, true);
	});

	it('POST thiếu Origin bị từ chối', () => {
		const request = new Request('https://api.alk.xx.kg/api/v1/files', { method: 'POST' });
		const result = validateOrigin(request, policy);
		assert.equal(result.ok, false);
		assert.match(result.reason ?? '', /thiếu Origin/);
	});

	it('POST Origin null bị từ chối', () => {
		const request = new Request('https://api.alk.xx.kg/api/v1/files', {
			method: 'POST',
			headers: { origin: 'null' },
		});
		assert.equal(validateOrigin(request, policy).ok, false);
	});

	it('POST Origin lạ bị từ chối', () => {
		const request = new Request('https://api.alk.xx.kg/api/v1/files', {
			method: 'POST',
			headers: { origin: 'https://evil.example' },
		});
		assert.equal(validateOrigin(request, policy).ok, false);
	});

	it('POST Origin hợp lệ + CSRF đúng => pass', () => {
		const request = new Request('https://api.alk.xx.kg/api/v1/files', {
			method: 'POST',
			headers: { origin: 'https://cloud.alk.xx.kg', 'x-alkcloud-csrf': 'secret' },
		});
		assert.equal(validateOrigin(request, policy).ok, true);
		assert.equal(validateCsrfToken(request, 'secret').ok, true);
	});

	it('CSRF sai bị từ chối', () => {
		const request = new Request('https://api.alk.xx.kg/api/v1/files', {
			method: 'POST',
			headers: { 'x-alkcloud-csrf': 'wrong' },
		});
		assert.equal(validateCsrfToken(request, 'secret').ok, false);
	});
});

describe('MemoryRateLimiter', () => {
	it('cho qua tới hạn rồi chặn', () => {
		const limiter = new MemoryRateLimiter(3, 60_000);
		assert.equal(limiter.consume('k', 0).allowed, true);
		assert.equal(limiter.consume('k', 1).allowed, true);
		assert.equal(limiter.consume('k', 2).allowed, true);
		const blocked = limiter.consume('k', 3);
		assert.equal(blocked.allowed, false);
		assert.equal(blocked.remaining, 0);
		assert.ok(blocked.retryAfterSeconds > 0);
	});

	it('reset khi hết window', () => {
		const limiter = new MemoryRateLimiter(1, 1000);
		assert.equal(limiter.consume('k', 0).allowed, true);
		assert.equal(limiter.consume('k', 100).allowed, false);
		assert.equal(limiter.consume('k', 1001).allowed, true);
	});

	it('sweep dọn bucket hết hạn', () => {
		const limiter = new MemoryRateLimiter(1, 1000);
		limiter.consume('a', 0);
		limiter.consume('b', 2000);
		assert.equal(limiter.sweep(3000), 2);
	});
});
