import assert from 'node:assert/strict';
import { runMigrations } from '@alkcloud/db';
import { SqliteDriver } from '@alkcloud/db/sqlite';
import { loadMigrationFiles } from '../../../packages/db/test/helpers.js';
import { createWorkerApp } from '../src/index.js';
import type { Env } from '../src/env.js';
import { API, ORIGIN, SETUP_TOKEN, AUTH_KEY } from './harness.js';

/**
 * Binding D1 giả — mô phỏng đúng API mà Cloudflare Worker nhận.
 * Cho phép test đi qua ĐÚNG đường production (`createWorkerApp`) thay vì
 * `createApp` trực tiếp — nơi mà bug "app dựng lại mỗi request" (SEC-01) đã ẩn.
 */
export async function createFakeD1Binding(): Promise<{ binding: unknown; close: () => void }> {
	const driver = new SqliteDriver(':memory:');
	// Migration chạy trên CHÍNH driver này ⇒ binding giả và app dùng chung 1 DB.
	await runMigrations(driver, loadMigrationFiles());

	const prepare = (sql: string) => {
		let params: unknown[] = [];
		const api = {
			bind(...values: unknown[]) {
				params = values;
				return api;
			},
			async all<T = Record<string, unknown>>() {
				const result = await driver.query<T>(sql, params);
				return {
					results: result.rows,
					meta: { rows_read: result.rows.length, rows_written: 0 },
				};
			},
			async run() {
				const result = await driver.run(sql, params);
				return {
					meta: {
						changes: result.changes ?? 0,
						last_row_id: result.lastRowId ?? 0,
						rows_written: 0,
					},
				};
			},
		};
		return api;
	};

	const binding = {
		prepare,
		async batch(statements: Array<{ sql: string; params?: unknown[] }>) {
			const results = await driver.batch(statements);
			return results.map((result) => ({ results: result.rows, meta: { changes: result.meta.changes ?? 0 } }));
		},
		async exec(sql: string) {
			await driver.exec(sql);
			return { count: 0, duration: 0 };
		},
	};

	return { binding, close: () => driver.close?.() };
}

export interface WorkerHarness {
	worker: ReturnType<typeof createWorkerApp>;
	env: Env;
	close: () => void;
	request: (
		path: string,
		options?: { method?: string; body?: unknown; headers?: Record<string, string>; cookie?: string },
	) => Promise<Response>;
}

/**
 * Harness đi qua đường production thật (`createWorkerApp`): app được cache
 * theo isolate ⇒ rate limiter có trạng thái giữa các request.
 */
export async function createWorkerHarness(): Promise<WorkerHarness> {
	const { binding, close } = await createFakeD1Binding();

	const env = {
		DB: binding,
		ALKCLOUD_ALLOWED_ORIGINS: ORIGIN,
		ALKCLOUD_PUBLIC_URL: 'https://cloud.alk.xx.kg',
		ALKCLOUD_API_URL: API,
		AUTH_PEPPER: 'test-pepper-value-0123456789',
		BOOTSTRAP_SETUP_TOKEN: SETUP_TOKEN,
		ENVIRONMENT: 'test',
	} as unknown as Env;

	const worker = createWorkerApp();
	const ctx = {
		waitUntil: () => undefined,
		passThroughOnException: () => undefined,
	} as unknown as ExecutionContext;

	let cookie = '';
	let csrf = '';
	const request = async (
		path: string,
		options: { method?: string; body?: unknown; headers?: Record<string, string>; cookie?: string } = {},
	) => {
		const headers: Record<string, string> = {
			origin: ORIGIN,
			'x-alkcloud-csrf': csrf,
			...(options.cookie !== undefined ? { cookie: options.cookie } : {}),
			...(options.body !== undefined ? { 'content-type': 'application/json' } : {}),
			...(options.headers ?? {}),
		};
		if (options.cookie === undefined && cookie) headers.cookie = cookie;
		return worker.fetch(
			new Request(`${API}${path}`, {
				method: options.method ?? 'GET',
				headers,
				body: options.body === undefined ? undefined : JSON.stringify(options.body),
			}),
			env,
			ctx,
		);
	};

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
	assert.equal(bootstrap.status, 201, `bootstrap thất bại: ${bootstrap.status}`);
	cookie = (bootstrap.headers.get('set-cookie') ?? '').split(';')[0] ?? '';
	csrf = ((await bootstrap.json()) as { session: { csrfToken: string } }).session.csrfToken;

	return { worker, env, close, request };
}
