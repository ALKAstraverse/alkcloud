#!/usr/bin/env node
/**
 * Phase 5 — xác minh monitoring/quota production (owner-only endpoints).
 *
 * - Đăng nhập bằng credential trong deploy/production-secrets.env (KHÔNG in giá trị).
 * - Gọi /system/diagnostics, /system/quota, /system/usage, /system/health/deep.
 * - Chỉ in số liệu tổng hợp (không token, không cookie).
 */
import { readFileSync, existsSync } from 'node:fs';
import { resolve } from 'node:path';
import { createRequire } from 'node:module';
import { deriveAuthKey } from './lib/auth-key.js';

const require = createRequire(import.meta.url);

const API = process.env.ALKCLOUD_E2E_API_URL ?? 'https://api.alk.xx.kg/api/v1';
const ORIGIN = process.env.ALKCLOUD_E2E_ORIGIN ?? 'https://cloud.alk.xx.kg';
const SECRETS_FILE = resolve(process.env.ALKCLOUD_SECRETS_FILE ?? 'deploy/production-secrets.env');

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

function b64u(bytes: Uint8Array): string {
	return Buffer.from(bytes).toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}


async function main(): Promise<void> {
	const env = readEnvFile(SECRETS_FILE);
	const email = env.OWNER_EMAIL ?? '';
	const password = env.OWNER_PASSWORD ?? '';
	if (!email || !password) throw new Error('thiếu OWNER_EMAIL/OWNER_PASSWORD trong file secrets');

	const paramsRes = await fetch(`${API}/auth/params`, { headers: { origin: ORIGIN } });
	const params = (await paramsRes.json()) as { salt: string; params?: string };
	const authKey = await deriveAuthKey(password, params.salt, params.params ?? '');

	const loginRes = await fetch(`${API}/auth/login`, {
		method: 'POST',
		headers: { 'content-type': 'application/json', origin: ORIGIN },
		body: JSON.stringify({ email, authKey }),
	});
	if (!loginRes.ok) throw new Error(`login thất bại: HTTP ${loginRes.status}`);
	const cookie = (loginRes.headers.get('set-cookie') ?? '').split(';')[0] ?? '';
	const csrf = (await loginRes.json() as { csrfToken?: string }).csrfToken ?? '';

	const get = async (path: string): Promise<unknown> => {
		const res = await fetch(`${API}${path}`, {
			headers: { cookie, origin: ORIGIN, 'x-alkcloud-csrf': csrf },
		});
		return res.json();
	};

	const diagnostics = (await get('/system/diagnostics')) as Record<string, unknown>;
	const quota = (await get('/system/quota')) as Record<string, unknown>;
	const usage = (await get('/system/usage')) as Record<string, unknown>;
	const deep = (await get('/system/health/deep')) as Record<string, unknown>;

	console.log('== AlkCloud — monitoring production (owner-only) ==');
	console.log('diagnostics:', JSON.stringify(diagnostics, null, 2));
	console.log('quota      :', JSON.stringify(quota));
	console.log('usage      :', JSON.stringify(usage));
	console.log('health/deep:', JSON.stringify(deep));
}

main().catch((error: unknown) => {
	console.error('lỗi:', error instanceof Error ? error.message : String(error));
	process.exitCode = 1;
});
