import assert from 'node:assert/strict';
import type { Hono } from 'hono';
import { Database, runMigrations } from '@alkcloud/db';
import { SqliteDriver } from '@alkcloud/db/sqlite';
import { MockObjectStorage } from '@alkcloud/storage';
import { createApp } from '../src/app.js';
import type { AppEnv } from '../src/middleware/auth.js';
import { resolveConfig } from '../src/env.js';
import type { Env } from '../src/env.js';
import { loadMigrationFiles } from '../../../packages/db/test/helpers.js';

export const ORIGIN = 'https://cloud.alk.xx.kg';
/** API base dùng khi gọi app trực tiếp (không qua harness.request). */
export const NOW_ORIGIN = 'https://api.alk.xx.kg';
export const API = 'https://api.alk.xx.kg/api/v1';
export const PEPPER = 'test-pepper-value-0123456789';
export const SETUP_TOKEN = 'setup-token-0123456789abcdef';
export const AUTH_KEY = 'client-argon2id-output-key-0001';

export interface Harness {
	app: Hono<AppEnv>;
	db: Database;
	storage: MockObjectStorage;
	config: ReturnType<typeof resolveConfig>;
	cookie: string;
	csrf: string;
	request: (
		path: string,
		options?: { method?: string; body?: unknown; headers?: Record<string, string>; cookie?: string },
	) => Promise<Response>;
}

export interface HarnessOptions {
	/** Ghi đè env (vd. `AUTH_PEPPER: undefined` để test fail-closed). */
	env?: Partial<Env>;
	/** false = bỏ qua bootstrap (dùng khi cấu hình thiếu pepper). */
	bootstrap?: boolean;
}

export async function createHarness(options: HarnessOptions = {}): Promise<Harness> {
	const driver = new SqliteDriver(':memory:');
	await runMigrations(driver, loadMigrationFiles());
	const db = new Database(driver);
	const storage = new MockObjectStorage();
	const env = {
		ALKCLOUD_ALLOWED_ORIGINS: ORIGIN,
		ALKCLOUD_PUBLIC_URL: 'https://cloud.alk.xx.kg',
		ALKCLOUD_API_URL: API,
		AUTH_PEPPER: PEPPER,
		BOOTSTRAP_SETUP_TOKEN: SETUP_TOKEN,
		ENVIRONMENT: 'test',
		...options.env,
	} as unknown as Env;
	const config = resolveConfig(env);
	const app = createApp({ db, storage, config, now: () => new Date('2026-01-15T10:00:00.000Z') });

	let cookie = '';
	let csrf = '';

	const request = async (
		path: string,
		options: { method?: string; body?: unknown; headers?: Record<string, string>; cookie?: string } = {},
	) => {
		const method = options.method ?? 'GET';
		const headers: Record<string, string> = {
			origin: ORIGIN,
			'x-alkcloud-csrf': csrf,
			...(options.cookie !== undefined ? { cookie: options.cookie } : {}),
			...(options.body !== undefined ? { 'content-type': 'application/json' } : {}),
			...(options.headers ?? {}),
		};
		if (options.cookie === undefined && cookie) headers.cookie = cookie;
		return app.fetch(
			new Request(`${API}${path}`, {
				method,
				headers,
				body: options.body === undefined ? undefined : JSON.stringify(options.body),
			}),
		);
	};

	if (options.bootstrap !== false) {
		const bootstrap = await request('/auth/bootstrap', {
			method: 'POST',
			body: {
				setupToken: SETUP_TOKEN,
				email: 'owner@alkcloud.test',
				authKey: AUTH_KEY,
				authVerifierSalt: 'salt-12345678',
				authParams: 'params-12345678',
			},
		});
		assert.equal(bootstrap.status, 201);
		const setCookie = bootstrap.headers.get('set-cookie') ?? '';
		cookie = setCookie.split(';')[0] ?? '';
		const body = (await bootstrap.json()) as { session: { csrfToken: string } };
		csrf = body.session.csrfToken;
	}

	return { app, db, storage, config, cookie, csrf, request };
}

