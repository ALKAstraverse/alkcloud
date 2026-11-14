import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { Database, runMigrations } from '@alkcloud/db';
import { SqliteDriver } from '@alkcloud/db/sqlite';
import { MockObjectStorage } from '@alkcloud/storage';
import { resolveConfig, type Env } from '../src/env.js';
import { runScheduledTasks } from '../src/lib/scheduled.js';
import { loadMigrationFiles } from '../../../packages/db/test/helpers.js';
import { createHarness } from './harness.js';

/**
 * AUD-01 / AUD-02 — purge 2 pha.
 *
 * Trước khi sửa, cron purge: xoá object ở storage **trước**, rồi xoá row D1 **vô
 * điều kiện** ⇒ hai lỗi:
 *   - AUD-01: file vừa được restore trong lúc cron chạy vẫn bị mất vĩnh viễn.
 *   - AUD-02: xoá object xong nhưng xoá row lỗi ⇒ row trỏ tới object không tồn tại
 *     ⇒ khi restore, file "ma" (không tải được).
 *
 * Sau khi sửa:
 *   - Pha 1 (`PENDING`): object còn nguyên ⇒ restore được (huỷ purge).
 *   - Pha 2 (`PURGING`): restore bị từ chối (409) ⇒ xoá object rồi xoá row an toàn.
 */

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
	storage: MockObjectStorage,
	scheduledTime: number,
	env: Env = makeEnv(),
): Promise<void> {
	await runScheduledTasks({
		db,
		storage,
		config: resolveConfig(env),
		env,
		scheduledTime,
	});
}

/** Tạo file trong trash đã quá hạn purge (30 ngày) + object tương ứng trong storage. */
async function seedTrashedFile(
	db: Database,
	storage: MockObjectStorage,
	now: string,
	id = 'fil_purge_lifecycle',
): Promise<{ id: string; objectKey: string }> {
	const objectKey = `objects/${id}/rev-1`;
	await db.createFile({
		id,
		folderId: null,
		name: `${id}.txt`,
		size: 5,
		contentType: 'text/plain',
		objectKey,
		revisionId: 'rev-1',
		etag: 'etag-1',
		checksumSha256: null,
		now,
	});
	storage.putObject(objectKey, {
		size: 5,
		contentType: 'text/plain',
		etag: 'etag-1',
		body: new TextEncoder().encode('hello'),
	});
	await db.softDeleteFile(id, 'bat_test', '2020-01-01T00:00:00.000Z', now);
	return { id, objectKey };
}

describe('AUD-01/AUD-02 — purge 2 pha (PENDING → PURGING)', () => {
	it('pha 1 chỉ đánh dấu PENDING — object ở storage CÒN NGUYÊN, row còn nguyên', async () => {
		const db = await makeDb();
		const storage = new MockObjectStorage();
		const now = '2026-01-01T00:00:00.000Z';
		const file = await seedTrashedFile(db, storage, now);

		await runCron(db, storage, Date.parse(now));

		const row = await db.getFile(file.id);
		assert.ok(row, 'row file phải còn (chưa tới lúc xoá vĩnh viễn)');
		assert.equal(row.purgeState, 'PENDING', 'file phải ở trạng thái PENDING');
		assert.ok(row.purgeMarkedAt, 'phải ghi mốc đánh dấu');
		assert.ok(await storage.headObject(file.objectKey), 'object ở storage PHẢI còn nguyên ở pha 1');
	});

	it('restore trong grace period huỷ purge — cron sau KHÔNG xoá file', async () => {
		const db = await makeDb();
		const storage = new MockObjectStorage();
		const now = '2026-01-01T00:00:00.000Z';
		const file = await seedTrashedFile(db, storage, now);

		await runCron(db, storage, Date.parse(now));
		assert.equal((await db.getFile(file.id))?.purgeState, 'PENDING');

		// Owner khôi phục file trong grace period ⇒ huỷ purge.
		const restored = await db.restoreFile(file.id, '2026-01-01T01:00:00.000Z');
		assert.equal(restored, true, 'phải khôi phục được (object còn nguyên)');

		// Cron chạy 2 ngày sau (đã qua grace) ⇒ file ĐÃ được restore ⇒ không xoá.
		await runCron(db, storage, Date.parse(now) + 48 * HOUR);

		const row = await db.getFile(file.id);
		assert.ok(row, 'file đã restore KHÔNG được xoá');
		assert.equal(row.deletedAt, null);
		assert.equal(row.purgeState, 'NONE', 'purge phải được huỷ');
		assert.ok(await storage.headObject(file.objectKey), 'object phải còn nguyên');
	});

	it('sau grace period cron xoá object ở storage VÀ row D1', async () => {
		const db = await makeDb();
		const storage = new MockObjectStorage();
		const now = '2026-01-01T00:00:00.000Z';
		const file = await seedTrashedFile(db, storage, now);

		await runCron(db, storage, Date.parse(now));
		await runCron(db, storage, Date.parse(now) + 25 * HOUR);

		assert.equal(await db.getFile(file.id), null, 'row phải bị xoá');
		assert.equal(await storage.headObject(file.objectKey), null, 'object phải bị xoá');
	});

	it('B2 lỗi tạm thời ⇒ state trở lại NONE và cron sau thử lại được', async () => {
		const db = await makeDb();
		const storage = new MockObjectStorage();
		const now = '2026-01-01T00:00:00.000Z';
		const file = await seedTrashedFile(db, storage, now);

		await runCron(db, storage, Date.parse(now));
		assert.equal((await db.getFile(file.id))?.purgeState, 'PENDING');

		// Lần xoá thất bại (B2 lỗi) ⇒ không được đánh dấu PURGING vĩnh viễn.
		storage.failWith(new Error('B2 tạm thời không khả dụng'));
		await runCron(db, storage, Date.parse(now) + 25 * HOUR);
		storage.clearFailure();
		const afterFailure = await db.getFile(file.id);
		assert.ok(afterFailure, 'row phải còn khi xoá object lỗi');
		assert.equal(afterFailure.purgeState, 'NONE', 'phải trả state về NONE để restore an toàn');
		assert.ok(await storage.headObject(file.objectKey), 'object phải còn (B2 lỗi trước khi xoá)');

		// Cron sau thử lại ⇒ xoá được cả object lẫn row.
		await runCron(db, storage, Date.parse(now) + 26 * HOUR);
		assert.equal(await db.getFile(file.id), null, 'lần cron sau phải xoá được row');
		assert.equal(await storage.headObject(file.objectKey), null, 'lần cron sau phải xoá được object');
	});

	it('file có share đang hoạt động ⇒ KHÔNG được đánh dấu purge', async () => {
		const db = await makeDb();
		const storage = new MockObjectStorage();
		const now = '2026-01-01T00:00:00.000Z';
		const file = await seedTrashedFile(db, storage, now);
		await db.createShare({
			id: 'shr_1',
			fileId: file.id,
			tokenHash: 'hash-1',
			passwordHash: null,
			passwordSalt: null,
			passwordParams: null,
			expiresAt: '2027-01-01T00:00:00.000Z',
			maxDownloads: null,
			now,
		});

		await runCron(db, storage, Date.parse(now) + 25 * HOUR);

		const row = await db.getFile(file.id);
		assert.ok(row, 'file có share phải còn');
		assert.notEqual(row.purgeState, 'PURGING', 'KHÔNG được xoá file còn share hoạt động');
		assert.ok(await storage.headObject(file.objectKey), 'object phải còn');
	});
});

describe('AUD-02 — restore bị từ chối khi purge đã bắt đầu (tránh file "ma")', () => {
	it('POST /files/:id/restore trả 409 khi state = PURGING', async () => {
		const harness = await createHarness();
		const created = await harness.request('/uploads', {
			method: 'POST',
			body: { fileName: 'purge-race.txt', contentType: 'text/plain', totalSize: 5, checksumSha256: null },
		});
		const session = (await created.json()) as {
			uploadSessionId: string;
			parts: Array<{ url: string }>;
		};
		const key = harness.storage.keyFromPresignedUrl(session.parts[0]!.url);
		harness.storage.putObject(key, {
			size: 5,
			contentType: 'text/plain',
			etag: 'etag-race',
			body: new TextEncoder().encode('hello'),
		});
		await harness.request(`/uploads/${session.uploadSessionId}/complete`, {
			method: 'POST',
			body: { parts: [{ partNumber: 1, etag: 'etag-race', size: 5 }], checksumSha256: null },
		});
		const list = (await (await harness.request('/files')).json()) as { files: Array<{ id: string }> };
		const fileId = list.files[0]!.id;

		await harness.request(`/files/${fileId}`, { method: 'DELETE' });
		await harness.db.sqlDriver.run(
			"UPDATE files SET purge_after = '2020-02-01T00:00:00.000Z' WHERE id = ?",
			[fileId],
		);
		// Purge đã bắt đầu (object có thể đã bị xoá) ⇒ restore phải bị từ chối.
		const started = await harness.db.markFilePurgeStarted(fileId, '2026-01-15T10:00:00.000Z');
		assert.equal(started, true, 'phải đánh dấu PURGING được');

		const restored = await harness.request(`/files/${fileId}/restore`, { method: 'POST' });
		assert.equal(restored.status, 409, 'restore phải bị từ chối (409) khi đang xoá vĩnh viễn');
		assert.ok(await harness.db.getFile(fileId), 'file phải còn trong trash');
	});
});
