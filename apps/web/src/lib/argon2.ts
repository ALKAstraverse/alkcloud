/**
 * Client-side Argon2id bằng hash-wasm.
 *
 * Mật khẩu gốc KHÔNG BAO GIỜ gửi lên server. Browser chỉ gửi `authKey`
 * (output Argon2id base64url) — server lưu SHA-256(authKey + pepper).
 * Lý do: Workers Free có CPU 10ms, không thể chạy Argon2id server-side.
 */

const ARGON2_MEMORY_KIB = 19_456; // 19 MiB — OWASP mức tối thiểu
const ARGON2_ITERATIONS = 2;
const ARGON2_PARALLELISM = 1;
const ARGON2_OUTPUT_LENGTH = 32;

export interface Argon2Params {
	memorySize: number;
	iterations: number;
	parallelism: number;
	outputLength: number;
}

export const DEFAULT_ARGON2_PARAMS: Argon2Params = {
	memorySize: ARGON2_MEMORY_KIB,
	iterations: ARGON2_ITERATIONS,
	parallelism: ARGON2_PARALLELISM,
	outputLength: ARGON2_OUTPUT_LENGTH,
};

export const AUTH_KEY_LENGTH = 43; // base64url của 32 byte

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
	for (let index = 0; index < binary.length; index++) bytes[index] = binary.charCodeAt(index);
	return bytes;
}

export interface DerivedAuthKey {
	authKey: string;
	authVerifierSalt: string;
	authParams: string;
}

export function parseArgon2Params(raw: string | null | undefined): Argon2Params {
	if (!raw) return DEFAULT_ARGON2_PARAMS;
	try {
		const parsed = JSON.parse(raw) as Partial<Argon2Params>;
		return {
			memorySize: parsed.memorySize ?? DEFAULT_ARGON2_PARAMS.memorySize,
			iterations: parsed.iterations ?? DEFAULT_ARGON2_PARAMS.iterations,
			parallelism: parsed.parallelism ?? DEFAULT_ARGON2_PARAMS.parallelism,
			outputLength: parsed.outputLength ?? DEFAULT_ARGON2_PARAMS.outputLength,
		};
	} catch {
		return DEFAULT_ARGON2_PARAMS;
	}
}

/**
 * Dẫn xuất authKey từ mật khẩu + salt.
 *
 * `salt` và `params` PHẢI giống hệt lúc đăng ký/đổi mật khẩu — nếu không,
 * Argon2id cho output khác ⇒ server không verify được.
 * Vì vậy khi đăng nhập, client lấy salt/params từ `GET /auth/params`.
 */
export async function deriveAuthKey(
	password: string,
	salt: string,
	params: Argon2Params = DEFAULT_ARGON2_PARAMS,
): Promise<DerivedAuthKey> {
	const { argon2id } = await import('hash-wasm');
	const saltBytes = base64UrlToBytes(salt);
	const hash = await argon2id({
		password,
		salt: saltBytes,
		parallelism: params.parallelism,
		iterations: params.iterations,
		memorySize: params.memorySize,
		hashLength: params.outputLength,
		outputType: 'binary',
	});
	return {
		authKey: bytesToBase64Url(hash),
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
