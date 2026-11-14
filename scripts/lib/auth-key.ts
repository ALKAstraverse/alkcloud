/**
 * Dẫn xuất `authKey` giống hệt web client (`apps/web/src/lib/kdf.ts`).
 *
 * Server trả `GET /auth/params` với `params` JSON. Từ lần chuyển KDF sang
 * PBKDF2-HMAC-SHA256 (600 000 vòng) — bắt buộc vì CSP edge chặn WebAssembly
 * nên `hash-wasm`/Argon2id không chạy được trong trình duyệt — `params` có
 * dạng `{"algo":"pbkdf2","hash":"sha-256","iterations":600000,"outputLength":32}`.
 *
 * Script Node cũ vẫn hard-code Argon2id ⇒ chạy sai ⇒ authKey không khớp ⇒
 * đăng nhập thất bại với lỗi khó hiểu. Helper này hỗ trợ CẢ HAI:
 *   - `algo: "pbkdf2"` → PBKDF2-HMAC-SHA256 (đường hiện hành).
 *   - thiếu `algo` nhưng có `memorySize` → Argon2id (tài khoản cũ, fallback).
 *
 * KHÔNG bao giờ in mật khẩu / salt / authKey.
 */
import { pbkdf2Sync } from 'node:crypto';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);

export interface RawKdfParams {
	algo?: string;
	hash?: string;
	iterations?: number;
	memorySize?: number;
	parallelism?: number;
	outputLength?: number;
}

const DEFAULT_PBKKDF2_ITERATIONS = 600_000;
const DEFAULT_OUTPUT_LENGTH = 32;

export function base64UrlToBuffer(value: string): Buffer {
	return Buffer.from(value.replace(/-/g, '+').replace(/_/g, '/'), 'base64');
}

export function toBase64Url(bytes: Uint8Array): string {
	return Buffer.from(bytes).toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

export function parseKdfParams(raw: string | null | undefined): RawKdfParams {
	if (!raw) return {};
	try {
		return JSON.parse(raw) as RawKdfParams;
	} catch {
		return {};
	}
}

export async function deriveAuthKey(
	password: string,
	saltB64u: string,
	paramsRaw: string | null | undefined,
): Promise<string> {
	const params = parseKdfParams(paramsRaw);
	const saltBytes = base64UrlToBuffer(saltB64u);

	if (params.algo === 'pbkdf2') {
		const iterations = Number.isFinite(params.iterations)
			? Number(params.iterations)
			: DEFAULT_PBKKDF2_ITERATIONS;
		const outputLength = Number.isFinite(params.outputLength)
			? Number(params.outputLength)
			: DEFAULT_OUTPUT_LENGTH;
		const bits = pbkdf2Sync(password, saltBytes, iterations, outputLength, 'sha256');
		return toBase64Url(new Uint8Array(bits));
	}

	// Fallback: Argon2id cho tài khoản cũ (params không khai báo `algo`).
	const { argon2id } = require('hash-wasm') as {
		argon2id(options: {
			password: string;
			salt: Buffer;
			parallelism: number;
			iterations: number;
			memorySize: number;
			hashLength: number;
			outputType: string;
		}): Promise<Uint8Array>;
	};
	const hash = await argon2id({
		password,
		salt: saltBytes,
		parallelism: params.parallelism ?? 1,
		iterations: params.iterations ?? 2,
		memorySize: params.memorySize ?? 19_456,
		hashLength: params.outputLength ?? DEFAULT_OUTPUT_LENGTH,
		outputType: 'binary',
	});
	return toBase64Url(hash);
}
