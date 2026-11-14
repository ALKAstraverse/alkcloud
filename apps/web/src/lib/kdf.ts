/**
 * Client-side KDF cho AlkCloud.
 *
 * VÌ SAO KHÔNG DÙNG ARGON2ID (hash-wasm) NỮA:
 *   `hash-wasm` chạy WebAssembly ⇒ trình duyệt gọi `WebAssembly.compile()` bị
 *   CSP chặn (`script-src 'self'` không có `wasm-unsafe-eval`) ⇒ đăng nhập chết
 *   ngay với lỗi "Compiling or instantiating WebAssembly module violates…".
 *   Bản Argon2id thuần JS (`@noble/hashes`) đo được ~28 giây cho 19 MiB ⇒
 *   không dùng được trên thực tế.
 *
 * DÙNG PBKDF2-HMAC-SHA256 qua WebCrypto: native (không WASM, không `eval`),
 * nhanh (~0,3–0,8 s), chạy được dưới CSP nghiêm ngặt nhất. Số vòng lặp theo
 * khuyến nghị OWASP cho PBKDF2-HMAC-SHA256 (600 000).
 *
 * Mô hình bảo vệ mật khẩu (KHÔNG đổi so với thiết kế cũ):
 *   1. Client: `authKey = KDF(password, salt, params)` — base64url.
 *   2. Client gửi `authKey` qua HTTPS (mật khẩu gốc KHÔNG rời trình duyệt).
 *   3. Server: `verifier = SHA-256(authKey + AUTH_PEPPER)`, so sánh timing-safe.
 *
 * Pepper phía server là lớp bảo vệ offline brute-force: thiếu pepper thì dump
 * DB không dùng được để dò mật khẩu.
 */

export interface KdfParams {
	algo: 'pbkdf2';
	hash: 'sha-256';
	iterations: number;
	outputLength: number;
}

export const DEFAULT_KDF_PARAMS: KdfParams = {
	algo: 'pbkdf2',
	hash: 'sha-256',
	iterations: 600_000,
	outputLength: 32,
};

export const AUTH_KEY_LENGTH = 43; // base64url của 32 byte

const MIN_ITERATIONS = 100_000;
const MAX_ITERATIONS = 2_000_000;

export function randomSalt(byteLength = 16): string {
	const bytes = new Uint8Array(byteLength);
	crypto.getRandomValues(bytes);
	return bytesToBase64Url(bytes);
}

export function bytesToBase64Url(bytes: Uint8Array): string {
	let binary = '';
	for (const byte of bytes) binary += String.fromCharCode(byte);
	return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

export function base64UrlToBytes(value: string): Uint8Array {
	const padded = value.replace(/-/g, '+').replace(/_/g, '/');
	const binary = atob(padded + '='.repeat((4 - (padded.length % 4)) % 4));
	const bytes = new Uint8Array(binary.length);
	for (let index = 0; index < binary.length; index += 1) bytes[index] = binary.charCodeAt(index);
	return bytes;
}

/**
 * Đọc tham số KDF do server lưu.
 *
 * Server KHÔNG diễn giải `auth_params` — nó chỉ lưu và trả lại đúng chuỗi
 * client gửi lúc đăng ký. Vì vậy client phải tự quyết định thuật toán, và
 * `salt`/`params` phải khớp lúc đăng ký, nếu không server không verify được.
 */
export function parseKdfParams(raw: string | null | undefined): KdfParams {
	if (!raw) return DEFAULT_KDF_PARAMS;
	let parsed: Record<string, unknown>;
	try {
		parsed = JSON.parse(raw) as Record<string, unknown>;
	} catch {
		return DEFAULT_KDF_PARAMS;
	}
	if (parsed.algo === undefined && parsed.memorySize === undefined) return DEFAULT_KDF_PARAMS;
	if (parsed.algo !== 'pbkdf2') {
		throw new Error(
			'Tài khoản đang dùng thuật toán băm cũ. Cần đặt lại mật khẩu từ chính thiết bị này để đăng nhập.',
		);
	}
	const iterations = Number(parsed.iterations);
	return {
		algo: 'pbkdf2',
		hash: 'sha-256',
		iterations: Number.isFinite(iterations)
			? Math.min(MAX_ITERATIONS, Math.max(MIN_ITERATIONS, Math.trunc(iterations)))
			: DEFAULT_KDF_PARAMS.iterations,
		outputLength: DEFAULT_KDF_PARAMS.outputLength,
	};
}

export interface DerivedAuthKey {
	authKey: string;
	authVerifierSalt: string;
	authParams: string;
}

/**
 * Dẫn xuất `authKey` từ mật khẩu + salt.
 *
 * `salt` và `params` PHẢI giống hệt lúc đăng ký/đổi mật khẩu — nếu không,
 * output khác ⇒ server không verify được.
 */
export async function deriveAuthKey(
	password: string,
	salt: string,
	params: KdfParams = DEFAULT_KDF_PARAMS,
): Promise<DerivedAuthKey> {
	const saltBytes = base64UrlToBytes(salt);
	const keyMaterial = await crypto.subtle.importKey(
		'raw',
		new TextEncoder().encode(password),
		'PBKDF2',
		false,
		['deriveBits'],
	);
	const bits = await crypto.subtle.deriveBits(
		{ name: 'PBKDF2', salt: saltBytes, iterations: params.iterations, hash: 'SHA-256' },
		keyMaterial,
		params.outputLength * 8,
	);
	return {
		authKey: bytesToBase64Url(new Uint8Array(bits)),
		authVerifierSalt: salt,
		authParams: JSON.stringify(params),
	};
}

/**
 * Verifier cho mật khẩu share.
 *
 * Người nhận chỉ có mật khẩu (không có salt riêng), nên verifier phải dùng
 * hằng số công khai. Server vẫn băm lần nữa với pepper trước khi so sánh.
 * Output: 64 ký tự hex (khớp regex `passwordVerifier` của API).
 */
export const SHARE_VERIFIER_CONTEXT = 'alkcloud-share-v1';

export async function deriveShareVerifier(password: string): Promise<string> {
	const digest = await crypto.subtle.digest(
		'SHA-256',
		new TextEncoder().encode(`${SHARE_VERIFIER_CONTEXT}:${password}`),
	);
	const bytes = new Uint8Array(digest);
	return Array.from(bytes)
		.map((byte) => byte.toString(16).padStart(2, '0'))
		.join('');
}
