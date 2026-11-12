import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { Database, runMigrations } from '@alkcloud/db';
import { SqliteDriver } from '@alkcloud/db/sqlite';
import { MockObjectStorage } from '@alkcloud/storage';
import { resolveConfig, type Env } from '../src/env.js';
import { runScheduledTasks } from '../src/lib/scheduled.js';
import { loadMigrationFiles } from '../../../packages/db/test/helpers.js';

const HOUR = 60 * 60 * 1000;

function makeEnv(overrides: Partial<Env> = {}): Env {
	return {
		ALKCLOUD_ALLOWED_ORIGINS: 'https://cloud.alk.xx.kg',
		AUTH_PEPPER: 'test-pepper-value-0123456789',
		BOOTSTRAP_SETUP_TOKEN: 'setup-token-0123456789abcdef',
		ENVIRONMENT: 'test',
		...overrides,
	} as unknown as Env;
}

async function makeDb(): Promise<Database> {
	const driver = new SqliteDriver(':memory:');
	await runMigrations(driver, loadMigrationFiles());
	return new Database(driver);
}

async function runCron(
	db: Database,
	scheduledTime: number,
	env: Env,
): Promise<void> {
	await runScheduledTasks({
		db,
		storage: new MockObjectStorage(),
		config: resolveConfig(env),
		env,
		scheduledTime,
	});
}

describe('P3-M0 — hysteresis của quota mode phải được lưu lại (auto-recovery)', () => {
	it('bộ đếm consecutiveBelow tích luỹ trong DB và hạ 1 bậc sau 3 chu kỳ', async () => {
		const db = await makeDb();
		const env = makeEnv();
		// Bắt đầu ở READ_ONLY như đã leo thang trước đó.
		await db.setSystemState(
			'quota_state',
			{
				mode: 'READ_ONLY',
				reason: 'test',
				accountRequestsUsed: 0,
				accountRequestLimit: 100_000,
				alkApiCallsUsed: 0,
				alkApiBudget: 20_000,
				evaluatedAt: '2026-01-01T00:00:00.000Z',
				consecutiveBelow: 0,
				lastChangedAt: '2026-01-01T00:00:00.000Z',
				updatedAt: '2026-01-01T00:00:00.000Z',
			},
			'2026-01-01T00:00:00.000Z',
		);

		// Không có analytics token ⇒ dataAvailable=false ⇒ fail-safe: giữ mode
		// và KHÔNG tích luỹ bộ đếm (không có dữ liệu thì không suy diễn).
		const base = Date.parse('2026-01-02T00:00:00.000Z');
		await runCron(db, base, env);
		let state = await db.getSystemState<{ mode: string; consecutiveBelow: number }>('quota_state');
		assert.equal(state?.mode, 'READ_ONLY');
		assert.equal(state?.consecutiveBelow, 0, 'không có dữ liệu ⇒ không được tích luỹ bộ đếm');

		// Có analytics trả về 0 request ⇒ dưới ngưỡng exit ⇒ tích luỹ bộ đếm.
		const originalFetch = globalThis.fetch;
		globalThis.fetch = (async () =>
			new Response(
				JSON.stringify({
					data: {
						viewer: {
							accounts: [
								{
									workersInvocationsAdaptive: [
										{ sum: { requests: 0 }, dimensions: { scriptName: 'alkcloud-api' } },
									],
								},
							],
						},
					},
				}),
				{ status: 200, headers: { 'content-type': 'application/json' } },
			)) as typeof fetch;
		const envWithAnalytics = makeEnv({
			CLOUDFLARE_ANALYTICS_TOKEN: 'token-analytics',
			CLOUDFLARE_ACCOUNT_ID: 'c3f46654371899594a8ddf59b863d211',
		});
		try {
			for (let cycle = 1; cycle <= 2; cycle += 1) {
				await runCron(db, base + cycle * HOUR, envWithAnalytics);
				state = await db.getSystemState<{ mode: string; consecutiveBelow: number }>('quota_state');
				assert.equal(state?.consecutiveBelow, cycle, `bộ đếm phải được lưu lại ở chu kỳ ${cycle}`);
			}
			// Chu kỳ 3: đủ 3 chu kỳ dưới ngưỡng + đã qua cooldown ⇒ hạ 1 bậc.
			await runCron(db, base + 3 * HOUR, envWithAnalytics);
			state = await db.getSystemState<{ mode: string; consecutiveBelow: number }>('quota_state');
			assert.equal(state?.mode, 'CONSERVE', 'phải hạ 1 bậc sau 3 chu kỳ dưới ngưỡng');
		} finally {
			globalThis.fetch = originalFetch;
		}
	});
});

describe('P3-M0 — analytics lỗi KHÔNG được coi là "0 request"', () => {
	it('HTTP 403 từ GraphQL ⇒ giữ mode, không tự hồi phục', async () => {
		const db = await makeDb();
		const env = makeEnv({
			CLOUDFLARE_ANALYTICS_TOKEN: 'token-that-lacks-scope',
			CLOUDFLARE_ACCOUNT_ID: 'c3f46654371899594a8ddf59b863d211',
		});
		await db.setSystemState(
			'quota_state',
			{
				mode: 'EMERGENCY',
				reason: 'test',
				accountRequestsUsed: 90_000,
				accountRequestLimit: 100_000,
				alkApiCallsUsed: 0,
				alkApiBudget: 20_000,
				evaluatedAt: '2026-01-01T00:00:00.000Z',
				consecutiveBelow: 2,
				lastChangedAt: '2026-01-01T00:00:00.000Z',
				updatedAt: '2026-01-01T00:00:00.000Z',
			},
			'2026-01-01T00:00:00.000Z',
		);
		const originalFetch = globalThis.fetch;
		globalThis.fetch = (async () =>
			new Response(JSON.stringify({ errors: [{ message: 'permission denied' }] }), {
				status: 403,
				headers: { 'content-type': 'application/json' },
			})) as typeof fetch;
		try {
			await runCron(db, Date.parse('2026-01-02T00:00:00.000Z'), env);
			const state = await db.getSystemState<{ mode: string; consecutiveBelow: number }>('quota_state');
			assert.equal(state?.mode, 'EMERGENCY', 'token lỗi KHÔNG được coi là 0 request ⇒ không hạ bậc');
			assert.equal(state?.consecutiveBelow, 2, 'bộ đếm không được tăng khi không có dữ liệu');
		} finally {
			globalThis.fetch = originalFetch;
		}
	});
});
