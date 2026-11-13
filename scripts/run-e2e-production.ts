#!/usr/bin/env node
/**
 * Wrapper: chạy E2E production với credential đọc từ file local mode 600.
 *
 * - Tính `ALKCLOUD_E2E_AUTH_KEY` (Argon2id với salt của owner) trong process.
 * - Truyền qua `env` cho child process ⇒ KHÔNG nằm trong argv/process list.
 * - KHÔNG in giá trị secret.
 */
import { readFileSync, existsSync } from 'node:fs';
import { resolve } from 'node:path';
import { createRequire } from 'node:module';
import { spawn } from 'node:child_process';
import { readFileSync as readFileSyncUnsafe } from 'node:fs';

const require = createRequire(import.meta.url);
const { argon2id } = require('hash-wasm');

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

async function main(): Promise<void> {
	const env = readEnvFile(SECRETS_FILE);
	const email = env.OWNER_EMAIL;
	const password = env.OWNER_PASSWORD;
	if (!email || !password) {
		console.error('Thiếu OWNER_EMAIL / OWNER_PASSWORD trong file local.');
		process.exit(2);
	}

	const paramsResponse = await fetch(`${API}/auth/params`, { headers: { origin: ORIGIN } });
	const paramsBody = (await paramsResponse.json()) as { salt: string; params: string };
	const params = paramsBody.params
		? (JSON.parse(paramsBody.params) as { memorySize: number; iterations: number; parallelism: number; outputLength: number })
		: { memorySize: 19_456, iterations: 2, parallelism: 1, outputLength: 32 };
	const saltBytes = Buffer.from(paramsBody.salt.replace(/-/g, '+').replace(/_/g, '/'), 'base64');
	const hash = await argon2id({
		password,
		salt: saltBytes,
		parallelism: params.parallelism,
		iterations: params.iterations,
		memorySize: params.memorySize,
		hashLength: params.outputLength,
		outputType: 'binary',
	});
	const authKey = Buffer.from(hash).toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');

	// Token Cloudflare cho bước backup (wrangler) — đọc theo LABEL, không in.
	const cfToken = (() => {
		const label = 'Edit Workers Scripts and D1';
		try {
			const raw = readFileSyncUnsafe('/home/ubuntu/.cloudflare/apikey', 'utf8');
			for (const line of raw.split('\n')) {
				const trimmed = line.trim();
				if (trimmed.startsWith(`${label}:`)) return trimmed.slice(label.length + 1).trim();
			}
		} catch {
			return '';
		}
		return '';
	})();

	const child = spawn(
		'node',
		['--import', 'tsx', 'scripts/e2e-production.ts'],
		{
			stdio: 'inherit',
			env: {
				...process.env,
				ALKCLOUD_E2E_API_URL: API,
				ALKCLOUD_E2E_ORIGIN: ORIGIN,
				ALKCLOUD_E2E_EMAIL: email,
				ALKCLOUD_E2E_AUTH_KEY: authKey,
				CLOUDFLARE_API_TOKEN: cfToken,
				CLOUDFLARE_ACCOUNT_ID: 'c3f46654371899594a8ddf59b863d211',
			},
		},
	);
	child.on('exit', (code) => process.exit(code ?? 1));
}

main().catch((error: unknown) => {
	console.error('Lỗi:', error instanceof Error ? error.message : String(error));
	process.exit(1);
});
