import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { Database, runMigrations } from '@alkcloud/db';
import { SqliteDriver } from '@alkcloud/db/sqlite';
import { MockObjectStorage } from '@alkcloud/storage';
import { resolveConfig, type Env } from '../src/env.js';
import { runScheduledTasks } from '../src/lib/scheduled.js';
import { loadMigrationFiles } from '../../../packages/db/test/helpers.js';
import { createHarness } from './harness.js';
import { MAX_OPEN_UPLOAD_SESSIONS } from '../src/routes/uploads.js';

/**
 * AUD-03 (giảm thiểu ở tầng app) + AUD-04 — quota guard theo account.
 *
 * - AUD-03: rate limit ở edge là theo IP ⇒ 1 IP tạo hàng loạt upload session. Guard
 *   mới đếm session OPEN từ D1 (authoritative, không theo IP) ⇒ chặn được cả khi
 *   đổi IP. Lớp edge vẫn cần owner cấp token `Rate Limiting Rules: Edit`.
 * - AUD-04: quota reservation mồ côi (không còn session OPEN) giữ quota vĩnh viễn
 *   ⇒ owner không upload được. Cron nay release các reservation đó.
 */

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

describe('AUD-04 — quota reservation mồ côi phải được release', () => {
	it('reservation không gắn session OPEN ⇒ cron release (quota không bị giữ vĩnh viễn)', async () => {
		const db = await makeDb();
		const env = makeEnv();
		await db.createOwner({
			id: 'own_test',
			email: 'owner@example.com',
			authVerifierHash: 'h',
			authVerifierSalt: 's',
			authParams: '{}',
			createdAt: '2026-01-01T00:00:00.000Z',
		});
		await db.sqlDriver.run(
			`INSERT INTO quota_reservations (id, owner_id, upload_session_id, bytes, state, created_at, released_at)
			 VALUES ('qrs_orphan', 'own_test', 'upl_khong_ton_tai', 123456, 'HELD', '2026-01-01T00:00:00.000Z', NULL)`,
		);

		await runScheduledTasks({
			db,
			storage: new MockObjectStorage(),
			config: resolveConfig(env),
			env,
			scheduledTime: Date.parse('2026-01-02T00:00:00.000Z'),
		});

		const rows = await db.sqlDriver.query<{ state: string }>(
			"SELECT state FROM quota_reservations WHERE id = 'qrs_orphan'",
		);
		assert.equal(rows.rows[0]?.state, 'RELEASED', 'reservation mồ côi phải được release');
	});
});

describe('AUD-03 — giới hạn số upload session OPEN (authoritative, theo account)', () => {
	it('vượt giới hạn session OPEN ⇒ API từ chối (429) bằng thông điệp rõ ràng', async () => {
		const harness = await createHarness();
		const now = new Date().toISOString();
		// Chèn tối đa số session OPEN được phép (giống hệt client thật).
		for (let index = 0; index < MAX_OPEN_UPLOAD_SESSIONS; index += 1) {
			await harness.db.sqlDriver.run(
				`INSERT INTO upload_sessions (id, file_name, file_name_lower, folder_id, content_type, total_size, object_key,
					part_size, part_count, reserved_bytes, status, created_at, updated_at, expires_at)
				 VALUES (?, ?, ?, NULL, 'text/plain', 0, ?, 0, 1, 0, 'OPEN', ?, ?, ?)`,
				[
					`upl_fill_${index}`,
					`fill-${index}.txt`,
					`fill-${index}.txt`,
					`objects/fill-${index}/rev`,
					now,
					now,
					new Date(Date.now() + 60 * 60 * 1000).toISOString(),
				],
			);
		}

		const openSessions = await harness.db.countOpenUploadSessions(now);
		assert.equal(openSessions, MAX_OPEN_UPLOAD_SESSIONS, 'phải đếm đủ số session OPEN');

		const created = await harness.request('/uploads', {
			method: 'POST',
			body: { fileName: 'should-be-rejected.txt', contentType: 'text/plain', totalSize: 1, checksumSha256: null },
		});
		assert.equal(created.status, 429, 'phải từ chối khi đã đủ số session OPEN');
		const body = (await created.json()) as { error?: { code?: string; message?: string } };
		assert.equal(body.error?.code, 'quota_exceeded');
		assert.match(body.error?.message ?? '', /upload/i);
	});
});
