import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { sha256Hex } from '@alkcloud/core';
import { OWNER_INPUT, createTestDb } from './helpers.js';

describe('migrations', () => {
	it('chạy idempotent (áp dụng 2 lần chỉ apply 1 lần)', async () => {
		const { driver } = await createTestDb();
		const { runMigrations } = await import('@alkcloud/db');
		const { loadMigrationFiles } = await import('./helpers.js');
		const result = await runMigrations(driver, loadMigrationFiles());
		assert.equal(result.applied.length, 0);
		assert.equal(result.skipped.length, loadMigrationFiles().length);
	});
});

describe('owner & session', () => {
	it('tạo owner và đọc lại', async () => {
		const { db } = await createTestDb();
		const owner = await db.createOwner(OWNER_INPUT);
		assert.equal(owner.email, 'owner@alkcloud.test');
		const fetched = await db.getOwner();
		assert.equal(fetched?.id, 'own_test');
		assert.equal(await db.countOwners(), 1);
	});

	it('từ chối owner thứ hai (email unique)', async () => {
		const { db } = await createTestDb();
		await db.createOwner(OWNER_INPUT);
		await assert.rejects(() =>
			db.createOwner({ ...OWNER_INPUT, id: 'own_2', email: OWNER_INPUT.email }),
		);
	});

	it('session: tìm theo token hash, revoke, list', async () => {
		const { db } = await createTestDb();
		await db.createOwner(OWNER_INPUT);
		await db.createSession({
			id: 'ses_1',
			ownerId: 'own_test',
			tokenHash: 'hash-1',
			csrfSecret: 'csrf-1',
			createdAt: '2026-01-01T00:00:00.000Z',
			expiresAt: '2026-02-01T00:00:00.000Z',
			userAgent: 'test-agent',
		});
		const found = await db.findSessionByTokenHash('hash-1');
		assert.equal(found?.id, 'ses_1');
		assert.equal(await db.findSessionByTokenHash('missing'), null);

		await db.revokeSession('ses_1', '2026-01-02T00:00:00.000Z');
		assert.ok((await db.findSessionByTokenHash('hash-1'))?.revokedAt);

		const sessions = await db.listSessions('own_test');
		assert.equal(sessions.length, 1);
	});
});

describe('recovery codes', () => {
	it('consume một lần, lần hai fail', async () => {
		const { db } = await createTestDb();
		await db.createOwner(OWNER_INPUT);
		const hash = await sha256Hex('code1');
		await db.replaceRecoveryCodes('own_test', [{ id: 'rec_1', codeHash: hash }], '2026-01-01T00:00:00.000Z');
		assert.equal(await db.countUnusedRecoveryCodes('own_test'), 1);
		assert.equal(await db.consumeRecoveryCode('own_test', hash, '2026-01-02T00:00:00.000Z'), true);
		assert.equal(await db.consumeRecoveryCode('own_test', hash, '2026-01-02T00:00:00.000Z'), false);
		assert.equal(await db.countUnusedRecoveryCodes('own_test'), 0);
	});
});

describe('folders', () => {
	it('tạo, đổi tên, di chuyển và lấy subtree', async () => {
		const { db } = await createTestDb();
		await db.createOwner(OWNER_INPUT);
		const parent = await db.createFolder({ id: 'fld_1', parentId: null, name: 'Docs', depth: 0, now: '2026-01-01T00:00:00.000Z' });
		const child = await db.createFolder({ id: 'fld_2', parentId: parent.id, name: 'Reports', depth: 1, now: '2026-01-01T00:00:00.000Z' });
		const grand = await db.createFolder({ id: 'fld_3', parentId: child.id, name: 'Q1', depth: 2, now: '2026-01-01T00:00:00.000Z' });

		assert.equal((await db.getFolder(parent.id))?.depth, 0);
		assert.equal((await db.getFolder(grand.id))?.depth, 2);

		const subtree = await db.listFolderSubtree(parent.id);
		assert.equal(subtree.length, 3);

		await db.renameFolder(parent.id, 'Tài liệu', '2026-01-02T00:00:00.000Z');
		assert.equal((await db.getFolder(parent.id))?.name, 'Tài liệu');

		await db.moveFolder(grand.id, null, 0, '2026-01-03T00:00:00.000Z');
		assert.equal((await db.getFolder(grand.id))?.parentId, null);
		assert.equal((await db.getFolder(grand.id))?.depth, 0);
	});

	it('chặn trùng tên cùng thư mục (case-insensitive) nhưng cho phép sau khi xoá', async () => {
		const { db } = await createTestDb();
		await db.createOwner(OWNER_INPUT);
		await db.createFolder({ id: 'fld_1', parentId: null, name: 'Photos', depth: 0, now: '2026-01-01T00:00:00.000Z' });
		await assert.rejects(() =>
			db.createFolder({ id: 'fld_2', parentId: null, name: 'photos', depth: 0, now: '2026-01-01T00:00:00.000Z' }),
		);
		await db.softDeleteFolder('fld_1', 'batch_1', '2026-01-02T00:00:00.000Z');
		const recreated = await db.createFolder({ id: 'fld_3', parentId: null, name: 'photos', depth: 0, now: '2026-01-02T00:00:00.000Z' });
		assert.equal(recreated.id, 'fld_3');
	});
});

describe('files', () => {
	it('tạo file, tìm theo object key, soft delete + restore', async () => {
		const { db } = await createTestDb();
		await db.createOwner(OWNER_INPUT);
		const file = await db.createFile({
			id: 'fil_1',
			folderId: null,
			name: 'report.pdf',
			size: 1024,
			contentType: 'application/pdf',
			objectKey: 'objects/fil_1/report.pdf',
			revisionId: 'rev_1',
			etag: 'etag-1',
			checksumSha256: null,
			now: '2026-01-01T00:00:00.000Z',
		});
		assert.equal(file.name, 'report.pdf');
		assert.equal((await db.getFileByObjectKey('objects/fil_1/report.pdf'))?.id, 'fil_1');

		await db.softDeleteFile('fil_1', 'batch_1', '2026-01-31T00:00:00.000Z', '2026-01-02T00:00:00.000Z');
		const trashed = await db.listFiles({ folderId: null, limit: 10, offset: 0, deletedOnly: false });
		assert.equal(trashed.length, 0);
		const trashList = await db.listTrashFiles(10);
		assert.equal(trashList.length, 1);

		await db.restoreFile('fil_1', '2026-01-03T00:00:00.000Z');
		const restored = await db.listFiles({ folderId: null, limit: 10, offset: 0, deletedOnly: false });
		assert.equal(restored.length, 1);
	});

	it('lọc theo thư mục và từ khoá', async () => {
		const { db } = await createTestDb();
		await db.createOwner(OWNER_INPUT);
		const folder = await db.createFolder({ id: 'fld_1', parentId: null, name: 'Media', depth: 0, now: '2026-01-01T00:00:00.000Z' });
		await db.createFile({
			id: 'fil_1', folderId: folder.id, name: 'alpha.png', size: 10, contentType: 'image/png',
			objectKey: 'objects/fil_1/alpha.png', revisionId: 'rev_1', etag: null, checksumSha256: null,
			now: '2026-01-01T00:00:00.000Z',
		});
		await db.createFile({
			id: 'fil_2', folderId: null, name: 'beta.png', size: 10, contentType: 'image/png',
			objectKey: 'objects/fil_2/beta.png', revisionId: 'rev_2', etag: null, checksumSha256: null,
			now: '2026-01-01T00:00:00.000Z',
		});
		const inFolder = await db.listFiles({ folderId: folder.id, limit: 10, offset: 0, deletedOnly: false });
		assert.equal(inFolder.length, 1);
		// folderId undefined = tìm kiếm toàn cục (mọi thư mục)
		const searched = await db.listFiles({ folderId: undefined, query: 'alpha', limit: 10, offset: 0, deletedOnly: false });
		assert.equal(searched.length, 1);
		// folderId null = chỉ root
		const rootOnly = await db.listFiles({ folderId: null, limit: 10, offset: 0, deletedOnly: false });
		assert.equal(rootOnly.length, 1);
		assert.equal(rootOnly[0]?.name, 'beta.png');
	});
});

describe('shares', () => {
	it('tạo share, đếm download nguyên tử, giới hạn max downloads', async () => {
		const { db } = await createTestDb();
		await db.createOwner(OWNER_INPUT);
		await db.createFile({
			id: 'fil_1', folderId: null, name: 'a.txt', size: 1, contentType: 'text/plain',
			objectKey: 'objects/fil_1/a.txt', revisionId: 'rev_1', etag: null, checksumSha256: null,
			now: '2026-01-01T00:00:00.000Z',
		});
		const share = await db.createShare({
			id: 'shr_1', fileId: 'fil_1', tokenHash: 'share-hash', passwordHash: null, passwordSalt: null,
			passwordParams: null, expiresAt: '2026-01-08T00:00:00.000Z', maxDownloads: 1,
			now: '2026-01-01T00:00:00.000Z',
		});
		assert.equal(share.downloadCount, 0);
		assert.equal(await db.incrementShareDownload('shr_1', '2026-01-02T00:00:00.000Z'), true);
		assert.equal(await db.incrementShareDownload('shr_1', '2026-01-02T00:00:00.000Z'), false);
		const updated = await db.getShareById('shr_1');
		assert.equal(updated?.downloadCount, 1);
	});
});

describe('audit hash chain', () => {
	it('chuỗi hash liên kết, mỗi entry trỏ về entry trước', async () => {
		const { db } = await createTestDb();
		await db.createOwner(OWNER_INPUT);
		await db.appendAudit({
			id: 'aud_1', action: 'auth.login.success', severity: 'info', actor: 'owner@alkcloud.test',
			targetType: 'session', targetId: 'ses_1', metadata: {}, ip: '127.0.0.1', now: '2026-01-01T00:00:00.000Z',
		});
		await db.appendAudit({
			id: 'aud_2', action: 'file.create', severity: 'info', actor: 'owner@alkcloud.test',
			targetType: 'file', targetId: 'fil_1', metadata: { size: 10 }, ip: '127.0.0.1', now: '2026-01-01T00:00:01.000Z',
		});
		const rows = await db.sqlDriver.query<{ prev_hash: string; entry_hash: string }>(
			'SELECT prev_hash, entry_hash FROM audit_logs ORDER BY created_at ASC',
		);
		assert.equal(rows.rows.length, 2);
		assert.equal(rows.rows[0]!.prev_hash, 'GENESIS');
		assert.equal(rows.rows[1]!.prev_hash, rows.rows[0]!.entry_hash);
	});

	it('lấy audit theo thứ tự mới nhất trước', async () => {
		const { db } = await createTestDb();
		await db.appendAudit({
			id: 'aud_1', action: 'auth.login.success', severity: 'info', actor: 'a',
			targetType: null, targetId: null, metadata: {}, ip: null, now: '2026-01-01T00:00:00.000Z',
		});
		await db.appendAudit({
			id: 'aud_2', action: 'auth.logout', severity: 'info', actor: 'a',
			targetType: null, targetId: null, metadata: {}, ip: null, now: '2026-01-02T00:00:00.000Z',
		});
		const list = await db.listAudit(10);
		assert.equal(list[0]?.action, 'auth.logout');
	});
});

describe('quota reservation', () => {
	it('reserve thành công khi còn quota, fail khi vượt', async () => {
		const { db } = await createTestDb();
		await db.createOwner(OWNER_INPUT);
		const ok = await db.reserveQuota(
			{ id: 'qrs_1', ownerId: 'own_test', uploadSessionId: 'upl_1', bytes: 600, now: '2026-01-01T00:00:00.000Z' },
			1000,
		);
		assert.equal(ok, true);
		assert.equal(await db.reservedQuotaBytes('own_test'), 600);

		const tooMuch = await db.reserveQuota(
			{ id: 'qrs_2', ownerId: 'own_test', uploadSessionId: 'upl_2', bytes: 500, now: '2026-01-01T00:00:00.000Z' },
			1000,
		);
		assert.equal(tooMuch, false);
		assert.equal(await db.reservedQuotaBytes('own_test'), 600);
	});

	it('release giải phóng quota', async () => {
		const { db } = await createTestDb();
		await db.createOwner(OWNER_INPUT);
		await db.reserveQuota(
			{ id: 'qrs_1', ownerId: 'own_test', uploadSessionId: 'upl_1', bytes: 900, now: '2026-01-01T00:00:00.000Z' },
			1000,
		);
		await db.releaseQuota('upl_1', '2026-01-02T00:00:00.000Z');
		assert.equal(await db.reservedQuotaBytes('own_test'), 0);
		const again = await db.reserveQuota(
			{ id: 'qrs_2', ownerId: 'own_test', uploadSessionId: 'upl_2', bytes: 900, now: '2026-01-02T00:00:00.000Z' },
			1000,
		);
		assert.equal(again, true);
	});

	it('reserve đồng thời: chỉ một lượt vượt ngưỡng mới thành công', async () => {
		const { db } = await createTestDb();
		await db.createOwner(OWNER_INPUT);
		const results = await Promise.all(
			Array.from({ length: 5 }, (_, index) =>
				db.reserveQuota(
					{ id: `qrs_${index}`, ownerId: 'own_test', uploadSessionId: `upl_${index}`, bytes: 300, now: '2026-01-01T00:00:00.000Z' },
					1000,
				),
			),
		);
		assert.equal(results.filter(Boolean).length, 3);
		assert.equal(await db.reservedQuotaBytes('own_test'), 900);
	});
});

describe('settings, system state, idempotency, usage', () => {
	it('settings round-trip', async () => {
		const { db } = await createTestDb();
		await db.setSetting('quotaBytes', 1234, '2026-01-01T00:00:00.000Z');
		assert.equal(await db.getSetting<number>('quotaBytes'), 1234);
		await db.setSetting('quotaBytes', 4321, '2026-01-02T00:00:00.000Z');
		assert.equal(await db.getSetting<number>('quotaBytes'), 4321);
	});

	it('system state round-trip', async () => {
		const { db } = await createTestDb();
		await db.setSystemState('quota_state', { mode: 'CONSERVE' }, '2026-01-01T00:00:00.000Z');
		const state = await db.getSystemState<{ mode: string }>('quota_state');
		assert.equal(state?.mode, 'CONSERVE');
	});

	it('idempotency: cùng key trả lại response đã lưu', async () => {
		const { db } = await createTestDb();
		await db.putIdempotency({
			key: 'key-1', ownerId: 'own_test', endpoint: 'POST /api/v1/uploads', requestHash: 'hash',
			statusCode: 201, responseBody: '{"ok":true}', now: '2026-01-01T00:00:00.000Z',
			expiresAt: '2026-01-02T00:00:00.000Z',
		});
		const found = await db.getIdempotency('key-1');
		assert.equal(found?.statusCode, 201);
		assert.equal(found?.responseBody, '{"ok":true}');
		const removed = await db.deleteExpiredIdempotency('2026-01-03T00:00:00.000Z');
		assert.equal(removed, 1);
	});

	it('usage_daily cộng dồn', async () => {
		const { db } = await createTestDb();
		await db.bumpUsageDaily('2026-01-01', { api_calls: 3, bytes_uploaded: 100 }, '2026-01-01T00:00:00.000Z');
		await db.bumpUsageDaily('2026-01-01', { api_calls: 2, bytes_uploaded: 50 }, '2026-01-01T00:01:00.000Z');
		const usage = await db.getUsageDaily('2026-01-01');
		assert.equal(usage?.api_calls, 5);
		assert.equal(usage?.bytes_uploaded, 150);
	});
});

describe('integrity fixes (Phase 2)', () => {
	it('xoá mềm folder cũng đưa file con vào trash cùng batch', async () => {
		const { db } = await createTestDb();
		await db.createOwner(OWNER_INPUT);
		await db.createFolder({ id: 'fld_1', parentId: null, name: 'docs', depth: 0, now: '2026-01-01T00:00:00.000Z' });
		await db.createFolder({ id: 'fld_2', parentId: 'fld_1', name: 'sub', depth: 1, now: '2026-01-01T00:00:00.000Z' });
		for (const [id, folderId] of [['fil_1', 'fld_1'], ['fil_2', 'fld_2'], ['fil_3', null]] as const) {
			await db.createFile({
				id, folderId, name: `${id}.txt`, size: 10, contentType: 'text/plain',
				objectKey: `objects/${id}/rev_${id}`, revisionId: `rev_${id}`, etag: null, checksumSha256: null,
				now: '2026-01-01T00:00:00.000Z',
			});
		}
		const subtree = await db.listFolderSubtree('fld_1');
		for (const node of subtree) await db.softDeleteFolder(node.id, 'bat_1', '2026-01-02T00:00:00.000Z');
		const deleted = await db.softDeleteFilesInFolders(
			subtree.map((node) => node.id),
			'bat_1',
			'2026-01-31T00:00:00.000Z',
			'2026-01-02T00:00:00.000Z',
		);
		assert.equal(deleted, 2);
		// File ngoài thư mục không bị đụng.
		assert.equal((await db.getFile('fil_3'))?.deletedAt, null);
		// File trong thư mục hiện trong trash (không mồ côi) và có hạn purge.
		const trash = await db.listTrashFiles(10);
		assert.equal(trash.length, 2);
		assert.ok(trash.every((file) => file.purgeAfter === '2026-01-31T00:00:00.000Z'));
		// Quota vẫn tính file đã xoá mềm (đúng: chỉ purge mới giải phóng).
		const due = await db.listFilesDueForPurge('2026-02-01T00:00:00.000Z', 10);
		assert.equal(due.length, 2);

		// Khôi phục theo batch đưa cả 2 file trở lại.
		const restored = await db.restoreFilesByBatch('bat_1', '2026-01-03T00:00:00.000Z');
		assert.equal(restored, 2);
		assert.equal((await db.listTrashFiles(10)).length, 0);
	});

	it('restoreFilesByBatch giới hạn theo folderIds (không hồi phục file ngoài phạm vi)', async () => {
		const { db } = await createTestDb();
		await db.createFolder({ id: 'fld_a', parentId: null, name: 'a', depth: 0, now: '2026-01-01T00:00:00.000Z' });
		await db.createFolder({ id: 'fld_b', parentId: null, name: 'b', depth: 0, now: '2026-01-01T00:00:00.000Z' });
		for (const [id, folderId] of [['fil_a', 'fld_a'], ['fil_b', 'fld_b']] as const) {
			await db.createFile({
				id, folderId, name: `${id}.txt`, size: 1, contentType: 'text/plain',
				objectKey: `objects/${id}/rev`, revisionId: 'rev', etag: null, checksumSha256: null,
				now: '2026-01-01T00:00:00.000Z',
			});
		}
		await db.softDeleteFilesInFolders(['fld_a', 'fld_b'], 'bat_x', '2026-01-31T00:00:00.000Z', '2026-01-02T00:00:00.000Z');
		// Chỉ khôi phục phạm vi fld_a ⇒ file của fld_b phải nằm lại trong trash
		// (nếu không, file vô hình: folder cha còn trong trash nhưng file đã bị bỏ trash).
		const restored = await db.restoreFilesByBatch('bat_x', '2026-01-03T00:00:00.000Z', ['fld_a']);
		assert.equal(restored, 1);
		assert.equal((await db.getFile('fil_a'))?.deletedAt, null);
		assert.notEqual((await db.getFile('fil_b'))?.deletedAt, null);
	});

	it('xoá cứng folder không xoá file con (ON DELETE SET NULL)', async () => {
		const { driver, db } = await createTestDb();
		await db.createFolder({ id: 'fld_1', parentId: null, name: 'bin', depth: 0, now: '2026-01-01T00:00:00.000Z' });
		await db.createFile({
			id: 'fil_1', folderId: 'fld_1', name: 'keep.txt', size: 1, contentType: 'text/plain',
			objectKey: 'objects/fil_1/rev_1', revisionId: 'rev_1', etag: null, checksumSha256: null,
			now: '2026-01-01T00:00:00.000Z',
		});
		await driver.run('DELETE FROM folders WHERE id = ?', ['fld_1']);
		const file = await db.getFile('fil_1');
		assert.ok(file, 'file phải còn sau khi xoá cứng folder');
		assert.equal(file?.folderId, null);
	});

	it('countActiveShares bỏ qua share đã hết hạn', async () => {
		const { db } = await createTestDb();
		await db.createOwner(OWNER_INPUT);
		await db.createFile({
			id: 'fil_1', folderId: null, name: 'a.txt', size: 1, contentType: 'text/plain',
			objectKey: 'objects/fil_1/rev_1', revisionId: 'rev_1', etag: null, checksumSha256: null,
			now: '2026-01-01T00:00:00.000Z',
		});
		await db.createShare({
			id: 'shr_old', fileId: 'fil_1', tokenHash: 'h1', passwordHash: null, passwordSalt: null,
			passwordParams: null, expiresAt: '2000-01-01T00:00:00.000Z', maxDownloads: null,
			now: '2026-01-01T00:00:00.000Z',
		});
		assert.equal(await db.countActiveShares('fil_1', '2026-01-01T00:00:00.000Z'), 0);
		await db.createShare({
			id: 'shr_new', fileId: 'fil_1', tokenHash: 'h2', passwordHash: null, passwordSalt: null,
			passwordParams: null, expiresAt: '2999-01-01T00:00:00.000Z', maxDownloads: null,
			now: '2026-01-01T00:00:00.000Z',
		});
		assert.equal(await db.countActiveShares('fil_1', '2026-01-01T00:00:00.000Z'), 1);
	});

	it('chỉ cho phép một owner duy nhất (chặn race bootstrap)', async () => {
		const { db } = await createTestDb();
		await db.createOwner(OWNER_INPUT);
		await assert.rejects(
			() =>
				db.createOwner({
					...OWNER_INPUT,
					id: 'own_2',
					email: 'second@alkcloud.test',
				}),
			/UNIQUE constraint failed/,
		);
	});

	it('audit chain không fork khi append đồng thời', async () => {
		const { db } = await createTestDb();
		await Promise.all(
			Array.from({ length: 10 }, (_, index) =>
				db.appendAudit({
					id: `aud_${index}`,
					action: 'auth.login.success',
					severity: 'info',
					actor: 'a',
					targetType: null,
					targetId: null,
					metadata: { index },
					ip: null,
					now: `2026-01-01T00:00:0${index}.000Z`,
				}),
			),
		);
		const rows = await db.sqlDriver.query<{ prev_hash: string; entry_hash: string }>(
			'SELECT prev_hash, entry_hash FROM audit_logs',
		);
		assert.equal(rows.rows.length, 10);
		// Không có 2 entry cùng prev_hash (fork) và không có entry tự trỏ chính nó.
		const prevHashes = rows.rows.map((row) => row.prev_hash);
		assert.equal(new Set(prevHashes).size, 10);
		assert.equal(prevHashes.filter((hash) => hash === 'GENESIS').length, 1);
	});

	it('quota tính cả file đang hoạt động (không chỉ reservation HELD)', async () => {
		const { db } = await createTestDb();
		await db.createOwner(OWNER_INPUT);
		await db.createFile({
			id: 'fil_big', folderId: null, name: 'big.bin', size: 900, contentType: 'application/octet-stream',
			objectKey: 'objects/fil_big/rev_1', revisionId: 'rev_1', etag: null, checksumSha256: null,
			now: '2026-01-01T00:00:00.000Z',
		});
		// 900 byte đã dùng + 200 byte mới > 1000 ⇒ từ chối.
		const reserved = await db.reserveQuota(
			{ id: 'qrs_1', ownerId: 'own_test', uploadSessionId: 'upl_1', bytes: 200, now: '2026-01-01T00:00:00.000Z' },
			1000,
		);
		assert.equal(reserved, false);
		const ok = await db.reserveQuota(
			{ id: 'qrs_2', ownerId: 'own_test', uploadSessionId: 'upl_2', bytes: 100, now: '2026-01-01T00:00:00.000Z' },
			1000,
		);
		assert.equal(ok, true);
	});

	it('moveFolder cập nhật depth của toàn bộ hậu duệ', async () => {
		const { db } = await createTestDb();
		await db.createFolder({ id: 'fld_a', parentId: null, name: 'a', depth: 0, now: '2026-01-01T00:00:00.000Z' });
		await db.createFolder({ id: 'fld_b', parentId: 'fld_a', name: 'b', depth: 1, now: '2026-01-01T00:00:00.000Z' });
		await db.createFolder({ id: 'fld_c', parentId: 'fld_b', name: 'c', depth: 2, now: '2026-01-01T00:00:00.000Z' });
		await db.createFolder({ id: 'fld_x', parentId: null, name: 'x', depth: 0, now: '2026-01-01T00:00:00.000Z' });
		await db.moveFolder('fld_a', 'fld_x', 1, '2026-01-02T00:00:00.000Z');
		assert.equal((await db.getFolder('fld_a'))?.depth, 1);
		assert.equal((await db.getFolder('fld_b'))?.depth, 2);
		assert.equal((await db.getFolder('fld_c'))?.depth, 3);
	});
});
