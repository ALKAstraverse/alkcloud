#!/usr/bin/env node
/**
 * Bootstrap owner AlkCloud production (Phase 5).
 *
 * - Đọc OWNER_EMAIL / OWNER_PASSWORD / BOOTSTRAP_SETUP_TOKEN từ file local mode 600
 *   (KHÔNG truyền qua argv, KHÔNG in ra terminal).
 * - Dựng authKey bằng đúng thuật toán client (PBKDF2-HMAC-SHA256 600 000 vòng
 *   qua WebCrypto — khớp `apps/web/src/lib/kdf.ts`) ⇒ server verify được.
 *   Argon2id KHÔNG dùng được nữa: CSP edge chặn WebAssembly và client đã
 *   chuyển sang PBKDF2 (tài khoản tạo bằng Argon2id sẽ không đăng nhập được).
 * - Ghi recovery codes vào file mode 600, KHÔNG in ra stdout.
 * - Idempotent: nếu đã có owner ⇒ không bootstrap lại (trả về thông báo).
 *
 * Action classification: PRODUCTION_WRITE (tạo owner + recovery codes).
 */
import { readFileSync, writeFileSync, existsSync, chmodSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { createRequire } from 'node:module';
import { deriveAuthKey } from './lib/auth-key.js';

const require = createRequire(import.meta.url);

const API = process.env.ALKCLOUD_E2E_API_URL ?? 'https://api.alk.xx.kg/api/v1';
const ORIGIN = process.env.ALKCLOUD_E2E_ORIGIN ?? 'https://cloud.alk.xx.kg';
const SECRETS_FILE = resolve(process.env.ALKCLOUD_SECRETS_FILE ?? 'deploy/production-secrets.env');
const OUT_FILE = resolve(process.env.ALKCLOUD_RECOVERY_FILE ?? 'deploy/owner-recovery-codes.txt');

function readEnvFile(path: string): Record<string, string> {
	const out: Record<string, string> = {};
	if (!existsSync(path)) return out;
	for (const line of readFileSync(path, 'utf8').split('\n')) {
		const trimmed = line.trim();
		if (!trimmed || trimmed.startsWith('#')) continue;
		const index = trimmed.indexOf('=');
		if (index === -1) continue;
		out[trimmed.slice(0, index)] = trimmed.slice(index + 1);
	}
	return out;
}

function bytesToBase64Url(bytes: Uint8Array): string {
	let binary = '';
	for (const byte of bytes) binary += String.fromCharCode(byte);
	return Buffer.from(binary, 'binary').toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

async function main(): Promise<void> {
	const env = readEnvFile(SECRETS_FILE);
	const email = env.OWNER_EMAIL;
	const password = env.OWNER_PASSWORD;
	const setupToken = env.BOOTSTRAP_SETUP_TOKEN;
	if (!email || !password || !setupToken) {
		console.error('Thiếu OWNER_EMAIL / OWNER_PASSWORD / BOOTSTRAP_SETUP_TOKEN trong file local.');
		process.exit(2);
	}

	// 0. Kiểm tra đã có owner chưa (KHÔNG tạo owner thứ hai).
	const status = await fetch(`${API}/auth/status`, { headers: { origin: ORIGIN } });
	const statusBody = (await status.json()) as { bootstrapped: boolean; environment: string };
	console.log(`auth/status: HTTP ${status.status} bootstrapped=${statusBody.bootstrapped} env=${statusBody.environment}`);
	if (statusBody.bootstrapped) {
		console.log('Đã có owner ⇒ KHÔNG bootstrap lại (idempotent, tránh tạo owner thứ hai).');
		process.exit(0);
	}

	// 1. Dựng salt + authKey đúng thuật toán client.
	const saltBytes = new Uint8Array(16);
	for (let i = 0; i < saltBytes.length; i += 1) saltBytes[i] = require('node:crypto').randomBytes(1)[0]!;
	const salt = bytesToBase64Url(saltBytes);
	const params = { algo: 'pbkdf2', hash: 'sha-256', iterations: 600_000, outputLength: 32 };
	const authKey = await deriveAuthKey(password, salt, JSON.stringify(params));

	// 2. Bootstrap.
	const response = await fetch(`${API}/auth/bootstrap`, {
		method: 'POST',
		headers: { 'content-type': 'application/json', origin: ORIGIN },
		body: JSON.stringify({
			setupToken,
			email,
			authKey,
			authVerifierSalt: salt,
			authParams: JSON.stringify(params),
		}),
	});
	const body = (await response.json()) as {
		owner?: { id: string; email: string };
		session?: { csrfToken: string; expiresAt: string };
		recoveryCodes?: string[];
		error?: { code: string; message: string };
	};
	if (response.status !== 201) {
		console.error(`Bootstrap thất bại: HTTP ${response.status} ${body.error?.code ?? ''} ${body.error?.message ?? ''}`);
		process.exit(1);
	}
	console.log(`Bootstrap OK: owner=${body.owner?.email} session_expires=${body.session?.expiresAt}`);
	const codes = body.recoveryCodes ?? [];
	console.log(`Recovery codes: ${codes.length} mã (KHÔNG in giá trị).`);

	// 3. Lưu recovery codes vào file mode 600.
	writeFileSync(
		OUT_FILE,
		[
			'# AlkCloud — RECOVERY CODES (mỗi mã dùng 1 lần)',
			'# Sinh lúc bootstrap: ' + new Date().toISOString(),
			'# Lưu vào password manager rồi XOÁ file này.',
			...codes,
			'',
		].join('\n'),
		{ mode: 0o600 },
	);
	chmodSync(OUT_FILE, 0o600);
	console.log(`Đã lưu recovery codes vào ${OUT_FILE} (mode 600).`);
}

main().catch((error: unknown) => {
	console.error('Lỗi:', error instanceof Error ? error.message : String(error));
	process.exit(1);
});
