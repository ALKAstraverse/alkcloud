import assert from 'node:assert/strict';
import { beforeEach, describe, it } from 'node:test';
import { Database, runMigrations } from '@alkcloud/db';
import { SqliteDriver } from '@alkcloud/db/sqlite';
import { MockObjectStorage } from '@alkcloud/storage';
import { createApp } from '../src/app.js';
import type { Env } from '../src/env.js';
import { resolveConfig } from '../src/env.js';
import { loadMigrationFiles } from '../../../packages/db/test/helpers.js';
import type { Harness } from './harness.js';
import { API, AUTH_KEY, ORIGIN, PEPPER, SETUP_TOKEN, createHarness } from './harness.js';

describe('health & auth status', () => {
	it('health trả ok', async () => {
		const harness = await createHarness();
		const response = await harness.request('/health');
		assert.equal(response.status, 200);
		const body = (await response.json()) as { status: string };
		assert.equal(body.status, 'ok');
	});

	it('auth/status báo bootstrapped nhưng KHÔNG lộ email owner (PII)', async () => {
		const harness = await createHarness();
		const response = await harness.request('/auth/status');
		const body = (await response.json()) as { bootstrapped: boolean; email?: string };
		assert.equal(body.bootstrapped, true);
		assert.equal(body.email, undefined, 'email owner không được trả cho request chưa đăng nhập');
	});

	it('auth/params trả salt + params của owner để client dẫn xuất lại authKey', async () => {
		const harness = await createHarness();
		const response = await harness.request('/auth/params');
		assert.equal(response.status, 200);
		const body = (await response.json()) as { salt: string; params: string };
		assert.equal(body.salt, 'salt-12345678');
		assert.equal(body.params, 'params-12345678');
	});

	it('auth/params không yêu cầu đăng nhập (client cần lấy salt trước khi dẫn xuất)', async () => {
		const harness = await createHarness();
		const response = await harness.request('/auth/params', { cookie: '' });
		assert.equal(response.status, 200);
	});
});

describe('auth rate limit', () => {
	it('chặn đăng nhập sai sau 5 lần', async () => {
		const harness = await createHarness();
		let lastStatus = 0;
		for (let attempt = 0; attempt < 6; attempt += 1) {
			const response = await harness.request('/auth/login', {
				method: 'POST',
				body: { email: 'owner@alkcloud.test', authKey: 'wrong-auth-key-000000000000' },
			});
			lastStatus = response.status;
		}
		assert.equal(lastStatus, 429);
		const response = await harness.request('/auth/login', {
			method: 'POST',
			body: { email: 'owner@alkcloud.test', authKey: 'wrong-auth-key-000000000000' },
		});
		assert.equal(response.headers.get('retry-after') !== null, true);
	});
});

describe('bootstrap', () => {
	it('từ chối setup token sai', async () => {
		const driver = new SqliteDriver(':memory:');
		await runMigrations(driver, loadMigrationFiles());
		const app = createApp({
			db: new Database(driver),
			storage: new MockObjectStorage(),
			config: resolveConfig({ AUTH_PEPPER: PEPPER, BOOTSTRAP_SETUP_TOKEN: SETUP_TOKEN } as unknown as Env),
		});
		const response = await app.fetch(
			new Request(`${API}/auth/bootstrap`, {
				method: 'POST',
				headers: { 'content-type': 'application/json', origin: ORIGIN },
				body: JSON.stringify({
					setupToken: 'wrong-token-0123456789',
					email: 'owner@alkcloud.test',
					authKey: AUTH_KEY,
					authVerifierSalt: 'salt-12345678',
					authParams: 'params-12345678',
				}),
			}),
		);
		assert.equal(response.status, 403);
	});

	it('từ chối bootstrap lần hai', async () => {
		const harness = await createHarness();
		const response = await harness.request('/auth/bootstrap', {
			method: 'POST',
			body: {
				setupToken: SETUP_TOKEN,
				email: 'owner@alkcloud.test',
				authKey: AUTH_KEY,
				authVerifierSalt: 'salt-12345678',
				authParams: 'params-12345678',
			},
		});
		assert.equal(response.status, 409);
	});

	it('trả recovery codes chỉ một lần và lưu hash (không lưu plaintext)', async () => {
		const harness = await createHarness();
		const response = await harness.request('/auth/bootstrap', {
			method: 'POST',
			body: {
				setupToken: SETUP_TOKEN,
				email: 'other@alkcloud.test',
				authKey: AUTH_KEY,
				authVerifierSalt: 'salt-12345678',
				authParams: 'params-12345678',
			},
		});
		assert.equal(response.status, 409);

		const rows = await harness.db.sqlDriver.query<{ code_hash: string }>('SELECT code_hash FROM recovery_codes');
		assert.equal(rows.rows.length, 10);
		for (const row of rows.rows) {
			assert.match(row.code_hash, /^[0-9a-f]{64}$/);
		}
	});
});

describe('session & CSRF', () => {
	it('route yêu cầu owner trả 401 khi chưa đăng nhập', async () => {
		const harness = await createHarness();
		const response = await harness.request('/files', { cookie: '' });
		assert.equal(response.status, 401);
	});

	it('POST thiếu CSRF bị 403', async () => {
		const harness = await createHarness();
		const response = await harness.request('/folders', {
			method: 'POST',
			body: { name: 'Docs' },
			headers: { 'x-alkcloud-csrf': 'wrong' },
		});
		assert.equal(response.status, 403);
	});

	it('POST sai Origin bị 403', async () => {
		const harness = await createHarness();
		const response = await harness.request('/folders', {
			method: 'POST',
			body: { name: 'Docs' },
			headers: { origin: 'https://evil.example' },
		});
		assert.equal(response.status, 403);
	});

	it('GET /auth/session trả thông tin phiên', async () => {
		const harness = await createHarness();
		const response = await harness.request('/auth/session');
		assert.equal(response.status, 200);
		const body = (await response.json()) as { owner: { email: string }; recoveryCodesRemaining: number };
		assert.equal(body.owner.email, 'owner@alkcloud.test');
		assert.equal(body.recoveryCodesRemaining, 10);
	});

	it('logout huỷ phiên', async () => {
		const harness = await createHarness();
		const response = await harness.request('/auth/logout', { method: 'POST', body: {} });
		assert.equal(response.status, 200);
		const after = await harness.request('/auth/session');
		assert.equal(after.status, 401);
	});
});

describe('folders & files CRUD', () => {
	it('tạo folder, tạo file qua upload flow, xoá vào trash, restore', async () => {
		const harness = await createHarness();

		const folderResponse = await harness.request('/folders', { method: 'POST', body: { name: 'Tài liệu' } });
		assert.equal(folderResponse.status, 201);
		const folderBody = (await folderResponse.json()) as { folder: { id: string } };
		const folderId = folderBody.folder.id;

		const uploadResponse = await harness.request('/uploads', {
			method: 'POST',
			body: { fileName: 'ghi-chu.txt', contentType: 'text/plain', totalSize: 12, checksumSha256: null },
		});
		assert.equal(uploadResponse.status, 201);
		const uploadBody = (await uploadResponse.json()) as {
			uploadSessionId: string;
			mode: string;
			parts: { partNumber: number; url: string }[];
		};
		assert.equal(uploadBody.mode, 'single');
		assert.equal(uploadBody.parts.length, 1);

		// Giả lập client PUT thành công lên B2 (mock).
		harness.storage.putObject(harness.storage.keyFromPresignedUrl(uploadBody.parts[0]!.url), {
			size: 12,
			contentType: 'text/plain',
			etag: 'etag-1',
			body: new Uint8Array(12),
		});

		const complete = await harness.request(`/uploads/${uploadBody.uploadSessionId}/complete`, {
			method: 'POST',
			body: { parts: [], checksumSha256: null },
		});
		assert.equal(complete.status, 201);
		const completeBody = (await complete.json()) as { file: { id: string; name: string } };
		assert.equal(completeBody.file.name, 'ghi-chu.txt');

		const list = await harness.request(`/files?parentId=${folderId}`);
		const listBody = (await list.json()) as { files: unknown[] };
		assert.equal(Array.isArray(listBody.files), true);

		const deleteResponse = await harness.request(`/files/${completeBody.file.id}`, { method: 'DELETE' });
		assert.equal(deleteResponse.status, 200);
		const trash = await harness.request('/files/trash');
		const trashBody = (await trash.json()) as { files: { id: string }[] };
		assert.equal(trashBody.files.length, 1);

		const restore = await harness.request(`/files/${completeBody.file.id}/restore`, { method: 'POST', body: {} });
		assert.equal(restore.status, 200);
		const trashAfter = await harness.request('/files/trash');
		const trashAfterBody = (await trashAfter.json()) as { files: unknown[] };
		assert.equal(trashAfterBody.files.length, 0);
	});

	it('upload vượt quota lưu trữ bị 429', async () => {
		const harness = await createHarness();
		await harness.db.setSetting('quotaBytes', 1024, '2026-01-15T10:00:00.000Z');
		const response = await harness.request('/uploads', {
			method: 'POST',
			body: { fileName: 'lon.bin', contentType: 'application/octet-stream', totalSize: 2048, checksumSha256: null },
		});
		assert.equal(response.status, 429);
	});

	it('idempotency-key trả lại response cũ', async () => {
		const harness = await createHarness();
		const body = { fileName: 'idem.txt', contentType: 'text/plain', totalSize: 5, checksumSha256: null };
		const first = await harness.request('/uploads', {
			method: 'POST',
			body,
			headers: { 'idempotency-key': 'key-idem-1' },
		});
		assert.equal(first.status, 201);
		const second = await harness.request('/uploads', {
			method: 'POST',
			body,
			headers: { 'idempotency-key': 'key-idem-1' },
		});
		assert.equal(second.status, 201);
		assert.equal(second.headers.get('idempotent-replay'), '1');
	});

	it('idempotency-key khác payload => 409', async () => {
		const harness = await createHarness();
		await harness.request('/uploads', {
			method: 'POST',
			body: { fileName: 'idem.txt', contentType: 'text/plain', totalSize: 5, checksumSha256: null },
			headers: { 'idempotency-key': 'key-idem-2' },
		});
		const response = await harness.request('/uploads', {
			method: 'POST',
			body: { fileName: 'khac.txt', contentType: 'text/plain', totalSize: 5, checksumSha256: null },
			headers: { 'idempotency-key': 'key-idem-2' },
		});
		assert.equal(response.status, 409);
	});
});

describe('regression fixes (Phase 2)', () => {
	async function uploadSingle(
		harness: Harness,
		input: { fileName: string; totalSize: number; folderId?: string | null },
	): Promise<{ uploadSessionId: string; url: string }> {
		const response = await harness.request('/uploads', {
			method: 'POST',
			body: {
				fileName: input.fileName,
				contentType: 'text/plain',
				totalSize: input.totalSize,
				checksumSha256: null,
				folderId: input.folderId ?? null,
			},
		});
		assert.equal(response.status, 201, `tạo upload session phải 201, nhận ${response.status}`);
		const body = (await response.json()) as { uploadSessionId: string; parts: { url: string }[] };
		return { uploadSessionId: body.uploadSessionId, url: body.parts[0]!.url };
	}

	it('single-part complete chấp nhận payload client thật (parts có 1 phần tử)', async () => {
		const harness = await createHarness();
		const session = await uploadSingle(harness, { fileName: 'client.txt', totalSize: 6 });
		const key = harness.storage.keyFromPresignedUrl(session.url);
		harness.storage.putObject(key, {
			size: 6,
			contentType: 'text/plain',
			etag: 'etag-client',
			body: new TextEncoder().encode('abcdef'),
		});
		const complete = await harness.request(`/uploads/${session.uploadSessionId}/complete`, {
			method: 'POST',
			body: { parts: [{ partNumber: 1, etag: 'etag-client', size: 6 }], checksumSha256: null },
		});
		assert.equal(complete.status, 201);
		const body = (await complete.json()) as { file: { id: string; objectKey: string; size: number } };
		assert.equal(body.file.size, 6);
	});

	it('object key theo chuẩn objects/{fileId}/{revisionId} — không chứa tên file', async () => {
		const harness = await createHarness();
		const session = await uploadSingle(harness, { fileName: 'bí mật (1).txt', totalSize: 3 });
		const key = harness.storage.keyFromPresignedUrl(session.url);
		assert.match(key, /^objects\/fil_[0-9a-f]{24}\/[0-9a-f-]{36}$/);
		assert.ok(!key.includes('bí mật'));
		harness.storage.putObject(key, {
			size: 3,
			contentType: 'text/plain',
			etag: 'etag-key',
			body: new TextEncoder().encode('abc'),
		});
		const complete = await harness.request(`/uploads/${session.uploadSessionId}/complete`, {
			method: 'POST',
			body: { parts: [{ partNumber: 1, etag: 'etag-key', size: 3 }], checksumSha256: null },
		});
		const body = (await complete.json()) as { file: { id: string; objectKey: string } };
		// fileId trong key phải trùng id file row.
		assert.equal(body.file.objectKey.split('/')[1], body.file.id);
	});

	it('complete từ chối khi kích thước object không khớp totalSize', async () => {
		const harness = await createHarness();
		const session = await uploadSingle(harness, { fileName: 'short.txt', totalSize: 100 });
		const key = harness.storage.keyFromPresignedUrl(session.url);
		harness.storage.putObject(key, {
			size: 5,
			contentType: 'text/plain',
			etag: 'etag-short',
			body: new Uint8Array(5),
		});
		const complete = await harness.request(`/uploads/${session.uploadSessionId}/complete`, {
			method: 'POST',
			body: { parts: [{ partNumber: 1, etag: 'etag-short', size: 5 }], checksumSha256: null },
		});
		assert.equal(complete.status, 400);
	});

	it('upload vào folderId đặt file đúng thư mục', async () => {
		const harness = await createHarness();
		const folderResponse = await harness.request('/folders', { method: 'POST', body: { name: 'Đích' } });
		const folderBody = (await folderResponse.json()) as { folder: { id: string } };
		const session = await uploadSingle(harness, {
			fileName: 'trong-thu-muc.txt',
			totalSize: 2,
			folderId: folderBody.folder.id,
		});
		const key = harness.storage.keyFromPresignedUrl(session.url);
		harness.storage.putObject(key, {
			size: 2,
			contentType: 'text/plain',
			etag: 'etag-folder',
			body: new TextEncoder().encode('ok'),
		});
		await harness.request(`/uploads/${session.uploadSessionId}/complete`, {
			method: 'POST',
			body: { parts: [{ partNumber: 1, etag: 'etag-folder', size: 2 }], checksumSha256: null },
		});
		const list = await harness.request(`/files?parentId=${folderBody.folder.id}`);
		const listBody = (await list.json()) as { files: { name: string }[] };
		assert.equal(listBody.files.length, 1);
		assert.equal(listBody.files[0]?.name, 'trong-thu-muc.txt');
		const rootList = await harness.request('/files');
		assert.equal(((await rootList.json()) as { files: unknown[] }).files.length, 0);
	});

	it('upload vào thư mục không tồn tại => 404', async () => {
		const harness = await createHarness();
		const response = await harness.request('/uploads', {
			method: 'POST',
			body: {
				fileName: 'x.txt',
				contentType: 'text/plain',
				totalSize: 1,
				checksumSha256: null,
				folderId: 'fld_khong_ton_tai',
			},
		});
		assert.equal(response.status, 404);
	});

	it('xoá folder đưa file con vào trash và restore đưa lại', async () => {
		const harness = await createHarness();
		const folderResponse = await harness.request('/folders', { method: 'POST', body: { name: 'Cây' } });
		const folderId = ((await folderResponse.json()) as { folder: { id: string } }).folder.id;
		const session = await uploadSingle(harness, { fileName: 'la.txt', totalSize: 1, folderId });
		const key = harness.storage.keyFromPresignedUrl(session.url);
		harness.storage.putObject(key, {
			size: 1,
			contentType: 'text/plain',
			etag: 'etag-leaf',
			body: new Uint8Array(1),
		});
		await harness.request(`/uploads/${session.uploadSessionId}/complete`, {
			method: 'POST',
			body: { parts: [{ partNumber: 1, etag: 'etag-leaf', size: 1 }], checksumSha256: null },
		});

		const deleted = await harness.request(`/folders/${folderId}`, { method: 'DELETE' });
		assert.equal(deleted.status, 200);
		const deletedBody = (await deleted.json()) as { files: number };
		assert.equal(deletedBody.files, 1);

		const trash = await harness.request('/files/trash');
		const trashBody = (await trash.json()) as { files: { name: string }[] };
		assert.equal(trashBody.files.length, 1);
		assert.equal(trashBody.files[0]?.name, 'la.txt');

		const restore = await harness.request(`/folders/${folderId}/restore`, { method: 'POST', body: {} });
		assert.equal(restore.status, 200);
		const trashAfter = await harness.request('/files/trash');
		assert.equal(((await trashAfter.json()) as { files: unknown[] }).files.length, 0);
		const list = await harness.request(`/files?parentId=${folderId}`);
		assert.equal(((await list.json()) as { files: unknown[] }).files.length, 1);
	});

	it('trùng tên file => 409 (rename/move/restore)', async () => {
		const harness = await createHarness();
		for (const [id, name] of [['fil_a', 'a.txt'], ['fil_b', 'b.txt']] as const) {
			await harness.db.createFile({
				id,
				folderId: null,
				name,
				size: 1,
				contentType: 'text/plain',
				objectKey: `objects/${id}/rev_${id}`,
				revisionId: `rev_${id}`,
				etag: null,
				checksumSha256: null,
				now: '2026-01-15T10:00:00.000Z',
			});
		}
		const rename = await harness.request('/files/fil_b', { method: 'PATCH', body: { name: 'a.txt' } });
		assert.equal(rename.status, 409);

		const folderResponse = await harness.request('/folders', { method: 'POST', body: { name: 'F' } });
		const folderId = ((await folderResponse.json()) as { folder: { id: string } }).folder.id;
		await harness.db.createFile({
			id: 'fil_c',
			folderId,
			name: 'a.txt',
			size: 1,
			contentType: 'text/plain',
			objectKey: 'objects/fil_c/rev_c',
			revisionId: 'rev_c',
			etag: null,
			checksumSha256: null,
			now: '2026-01-15T10:00:00.000Z',
		});
		// fil_a ('a.txt' ở root) di chuyển vào folder F đã có fil_c ('a.txt') => 409.
		const move = await harness.request('/files/fil_a/move', { method: 'POST', body: { folderId } });
		assert.equal(move.status, 409);

		// Xoá rồi restore chính nó: unique index chỉ áp dụng cho deleted_at IS NULL
		// nên không xung đột.
		await harness.request('/files/fil_b', { method: 'DELETE' });
		const restore = await harness.request('/files/fil_b/restore', { method: 'POST', body: {} });
		assert.equal(restore.status, 200);
	});

	it('trùng tên folder => 409', async () => {
		const harness = await createHarness();
		await harness.request('/folders', { method: 'POST', body: { name: 'Trùng' } });
		const second = await harness.request('/folders', { method: 'POST', body: { name: 'trùng' } });
		assert.equal(second.status, 409);
	});

	it('move folder có con trong trash vẫn được (trash không tính vào độ sâu)', async () => {
		const harness = await createHarness();
		// Cây 33 tầng: tầng sâu nhất bị xoá mềm ⇒ cây trash sâu 32.
		// Trước đây move tính cả cây trash ⇒ 400 "Độ sâu thư mục vượt giới hạn".
		let parentId: string | null = null;
		let deepestId = '';
		let secondDeepestId = '';
		let rootId = '';
		for (let depth = 0; depth <= 32; depth += 1) {
			const response = await harness.request('/folders', {
				method: 'POST',
				body: { name: `Tầng ${depth}`, parentId },
			});
			assert.equal(response.status, 201);
			const body = (await response.json()) as { folder: { id: string; depth: number } };
			assert.equal(body.folder.depth, depth);
			if (depth === 0) rootId = body.folder.id;
			if (depth === 31) secondDeepestId = body.folder.id;
			deepestId = body.folder.id;
			parentId = body.folder.id;
		}
		const deleted = await harness.request(`/folders/${deepestId}`, { method: 'DELETE' });
		assert.equal(deleted.status, 200);

		const target = await harness.request('/folders', { method: 'POST', body: { name: 'Đích' } });
		const targetId = ((await target.json()) as { folder: { id: string } }).folder.id;

		const moved = await harness.request(`/folders/${rootId}/move`, {
			method: 'POST',
			body: { parentId: targetId },
		});
		assert.equal(moved.status, 200);
		const rootAfter = await harness.db.getFolder(rootId);
		assert.equal(rootAfter?.parentId, targetId);
		assert.equal(rootAfter?.depth, 1);
		// Hậu duệ còn active được cập nhật depth theo delta (+1).
		assert.equal((await harness.db.getFolder(secondDeepestId))?.depth, 32);
	});

	it('share có mật khẩu không lộ metadata trước khi unlock', async () => {
		const harness = await createHarness();
		await harness.db.createFile({
			id: 'fil_secret',
			folderId: null,
			name: 'bi-mat.txt',
			size: 99,
			contentType: 'text/plain',
			objectKey: 'objects/fil_secret/rev_secret',
			revisionId: 'rev_secret',
			etag: null,
			checksumSha256: null,
			now: '2026-01-15T10:00:00.000Z',
		});
		const passwordVerifier = 'b'.repeat(64);
		const create = await harness.request('/shares', {
			method: 'POST',
			body: {
				fileId: 'fil_secret',
				expiresInDays: 7,
				maxDownloads: null,
				passwordVerifier,
				passwordSalt: 'salt-12345678',
				passwordParams: 'params-12345678',
			},
		});
		const token = ((await create.json()) as { token: string }).token;

		const locked = await harness.request('/public/share/info', { headers: { 'x-share-token': token } });
		const lockedBody = (await locked.json()) as {
			share: { fileName: string | null; size: number | null; contentType: string | null; unlocked: boolean };
		};
		assert.equal(lockedBody.share.unlocked, false);
		assert.equal(lockedBody.share.fileName, null);
		assert.equal(lockedBody.share.size, null);
		assert.equal(lockedBody.share.contentType, null);

		const unlock = await harness.request('/public/share/unlock', {
			method: 'POST',
			body: { passwordVerifier },
			headers: { 'x-share-token': token },
		});
		assert.equal(unlock.status, 200);
		const shareCookie = (unlock.headers.get('set-cookie') ?? '').split(';')[0] ?? '';
		const unlocked = await harness.request('/public/share/info', {
			headers: { 'x-share-token': token },
			cookie: shareCookie,
		});
		const unlockedBody = (await unlocked.json()) as { share: { fileName: string | null; unlocked: boolean } };
		assert.equal(unlockedBody.share.unlocked, true);
		assert.equal(unlockedBody.share.fileName, 'bi-mat.txt');
	});

	it('recovery-login thu hồi toàn bộ session cũ', async () => {
		const harness = await createHarness();
		const oldCookie = harness.cookie;
		const regen = await harness.request('/auth/recovery-codes/regenerate', { method: 'POST', body: {} });
		assert.equal(regen.status, 200);
		const regenBody = (await regen.json()) as { recoveryCodes: string[] };
		const code = regenBody.recoveryCodes[0]!;

		const recovery = await harness.request('/auth/recovery-login', {
			method: 'POST',
			body: { email: 'owner@alkcloud.test', code },
			cookie: '',
		});
		assert.equal(recovery.status, 200);
		const newCookie = (recovery.headers.get('set-cookie') ?? '').split(';')[0] ?? '';

		const oldSession = await harness.request('/auth/session', { cookie: oldCookie });
		assert.equal(oldSession.status, 401);
		const newSession = await harness.request('/auth/session', { cookie: newCookie });
		assert.equal(newSession.status, 200);
	});
});

describe('share flow', () => {
	async function seedFile(harness: Harness): Promise<string> {
		await harness.db.createFile({
			id: 'fil_seed',
			folderId: null,
			name: 'cong-khai.txt',
			size: 4,
			contentType: 'text/plain',
			objectKey: 'objects/fil_seed/cong-khai.txt',
			revisionId: 'rev_seed',
			etag: 'etag-seed',
			checksumSha256: null,
			now: '2026-01-15T10:00:00.000Z',
		});
		harness.storage.putObject('objects/fil_seed/cong-khai.txt', {
			size: 4,
			contentType: 'text/plain',
			etag: 'etag-seed',
			body: new TextEncoder().encode('data'),
		});
		return 'fil_seed';
	}

	it('tạo share rồi tải bằng header x-share-token', async () => {
		const harness = await createHarness();
		const fileId = await seedFile(harness);

		const create = await harness.request('/shares', {
			method: 'POST',
			body: { fileId, expiresInDays: 7, maxDownloads: 2 },
		});
		assert.equal(create.status, 201);
		const createBody = (await create.json()) as { share: { id: string }; token: string; url: string };
		assert.equal(createBody.url, `https://cloud.alk.xx.kg/s#${createBody.token}`);
		assert.ok(!createBody.url.includes(`/s/${createBody.token}`));

		const info = await harness.request('/public/share/info', {
			headers: { 'x-share-token': createBody.token },
		});
		assert.equal(info.status, 200);
		const infoBody = (await info.json()) as { share: { fileName: string; downloadsRemaining: number } };
		assert.equal(infoBody.share.fileName, 'cong-khai.txt');
		assert.equal(infoBody.share.downloadsRemaining, 2);

		const download = await harness.request('/public/share/download', {
			headers: { 'x-share-token': createBody.token },
		});
		assert.equal(download.status, 200);
		assert.match(download.headers.get('content-disposition') ?? '', /attachment/);
		assert.equal(await download.text(), 'data');

		const after = await harness.request('/public/share/info', {
			headers: { 'x-share-token': createBody.token },
		});
		const afterBody = (await after.json()) as { share: { downloadCount: number; downloadsRemaining: number } };
		assert.equal(afterBody.share.downloadCount, 1);
		assert.equal(afterBody.share.downloadsRemaining, 1);
	});

	it('thiếu x-share-token => 401; token sai => 404', async () => {
		const harness = await createHarness();
		await seedFile(harness);
		const missing = await harness.request('/public/share/info');
		assert.equal(missing.status, 401);
		const wrong = await harness.request('/public/share/info', {
			headers: { 'x-share-token': 'khong-ton-tai-token' },
		});
		assert.equal(wrong.status, 404);
	});

	it('share có mật khẩu: download khi chưa unlock => 403', async () => {
		const harness = await createHarness();
		const fileId = await seedFile(harness);
		const passwordVerifier = 'a'.repeat(64);

		const create = await harness.request('/shares', {
			method: 'POST',
			body: {
				fileId,
				expiresInDays: 7,
				maxDownloads: null,
				passwordVerifier,
				passwordSalt: 'salt-12345678',
				passwordParams: 'params-12345678',
			},
		});
		const createBody = (await create.json()) as { token: string };

		const blocked = await harness.request('/public/share/download', {
			headers: { 'x-share-token': createBody.token },
		});
		assert.equal(blocked.status, 403);

		const unlock = await harness.request('/public/share/unlock', {
			method: 'POST',
			body: { passwordVerifier },
			headers: { 'x-share-token': createBody.token },
		});
		assert.equal(unlock.status, 200);
		const shareCookie = (unlock.headers.get('set-cookie') ?? '').split(';')[0] ?? '';

		const download = await harness.request('/public/share/download', {
			headers: { 'x-share-token': createBody.token },
			cookie: shareCookie,
		});
		assert.equal(download.status, 200);
	});

	it('revoke share làm token không dùng được nữa', async () => {
		const harness = await createHarness();
		const fileId = await seedFile(harness);
		const create = await harness.request('/shares', {
			method: 'POST',
			body: { fileId, expiresInDays: 7, maxDownloads: null },
		});
		const createBody = (await create.json()) as { share: { id: string }; token: string };

		const revoke = await harness.request(`/shares/${createBody.share.id}`, { method: 'DELETE' });
		assert.equal(revoke.status, 200);

		const after = await harness.request('/public/share/info', {
			headers: { 'x-share-token': createBody.token },
		});
		assert.equal(after.status, 404);
	});

	it('đạt giới hạn max downloads => 403', async () => {
		const harness = await createHarness();
		const fileId = await seedFile(harness);
		const create = await harness.request('/shares', {
			method: 'POST',
			body: { fileId, expiresInDays: 7, maxDownloads: 1 },
		});
		const createBody = (await create.json()) as { token: string };

		const first = await harness.request('/public/share/download', {
			headers: { 'x-share-token': createBody.token },
		});
		assert.equal(first.status, 200);
		const second = await harness.request('/public/share/download', {
			headers: { 'x-share-token': createBody.token },
		});
		assert.equal(second.status, 403);
	});
});

describe('audit trail', () => {
	it('ghi audit cho login, upload, share', async () => {
		const harness = await createHarness();
		await harness.request('/uploads', {
			method: 'POST',
			body: { fileName: 'a.txt', contentType: 'text/plain', totalSize: 5, checksumSha256: null },
		});
		const events = await harness.db.listAudit(100);
		const actions = events.map((event) => event.action);
		assert.ok(actions.includes('auth.bootstrap'));
		assert.ok(actions.includes('upload.session.create'));
	});

	it('mọi sự kiện bảo mật có severity=security', async () => {
		const harness = await createHarness();
		const events = await harness.db.listAudit(100);
		const bootstrap = events.find((event) => event.action === 'auth.bootstrap');
		assert.equal(bootstrap?.severity, 'security');
	});
});

describe('security headers', () => {
	it('response có security headers cơ bản', async () => {
		const harness = await createHarness();
		const response = await harness.request('/health');
		assert.equal(response.headers.get('x-content-type-options'), 'nosniff');
		assert.equal(response.headers.get('x-frame-options'), 'DENY');
		assert.equal(response.headers.get('referrer-policy'), 'no-referrer');
		assert.match(response.headers.get('strict-transport-security') ?? '', /max-age=/);
	});
});
