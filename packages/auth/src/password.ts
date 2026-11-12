import { sha256Hex, timingSafeEqual } from '@alkcloud/core';

/**
 * Mô hình xác thực AlkCloud:
 *  1. Client (browser) chạy Argon2id(password, salt, params) → `authKey` (base64url).
 *  2. Client gửi `authKey` qua HTTPS tới API.
 *  3. Server tính verifier = SHA-256(authKey || AUTH_PEPPER) và so sánh với giá trị đã lưu.
 *
 * Nhờ vậy:
 *  - Server không bao giờ nhìn thấy mật khẩu gốc.
 *  - Argon2id chạy ngoài Worker (giữ CPU 10ms của Workers Free).
 *  - Dump DB chỉ chứa SHA-256(pepper) — không dùng được nếu thiếu pepper.
 */
export async function computeVerifier(authKey: string, pepper: string): Promise<string> {
	return sha256Hex(`${authKey}${pepper}`);
}

export async function verifyAuthKey(
	authKey: string,
	pepper: string,
	expectedVerifier: string,
): Promise<boolean> {
	const candidate = await computeVerifier(authKey, pepper);
	return timingSafeEqual(candidate, expectedVerifier);
}

export function isPepperConfigured(pepper: string | undefined): pepper is string {
	return typeof pepper === 'string' && pepper.length >= 16;
}
