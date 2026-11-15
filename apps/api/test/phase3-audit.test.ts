import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { createApp } from '../src/app.js';
import { createHarness, NOW_ORIGIN, ORIGIN } from './harness.js';

const NOW = '2026-01-15T10:00:00.000Z';

describe('P3-M0 — pepper fail-closed (không dùng hằng số công khai)', () => {
	it('tạo share có mật khẩu khi thiếu AUTH_PEPPER => 503 not_configured', async () => {
		const harness = await createHarness();
		await harness.db.createFile({
			id: 'fil_p',
			folderId: null,
			name: 'p.txt',
			size: 1,
			contentType: 'text/plain',
			objectKey: 'objects/fil_p/rev',
			revisionId: 'rev',
			etag: null,
			checksumSha256: null,
			now: NOW,
		});
		// App thứ hai dùng CÙNG database nhưng config KHÔNG có pepper.
		const app = createApp({
			db: harness.db,
			storage: harness.storage,
			config: { ...harness.config, authPepper: null },
			now: () => new Date(NOW),
		});
		const response = await app.fetch(
			new Request(`${NOW_ORIGIN}/api/v1/shares`, {
				method: 'POST',
				headers: {
					origin: ORIGIN,
					'content-type': 'application/json',
					'x-alkcloud-csrf': harness.csrf,
					cookie: harness.cookie,
				},
				body: JSON.stringify({
					fileId: 'fil_p',
					expiresInDays: 7,
					maxDownloads: null,
					passwordVerifier: 'b'.repeat(64),
					passwordSalt: 'salt-12345678',
					passwordParams: 'params-12345678',
				}),
			}),
		);
		assert.equal(response.status, 503);
		const body = (await response.json()) as { error: { code: string } };
		assert.equal(body.error.code, 'not_configured');
	});

	it('public share endpoints khi thiếu AUTH_PEPPER => 503 (grant không được ký bằng hằng số công khai)', async () => {
		const harness = await createHarness({ bootstrap: false });
		await harness.db.createFile({
			id: 'fil_x',
			folderId: null,
			name: 'x.txt',
			size: 1,
			contentType: 'text/plain',
			objectKey: 'objects/fil_x/rev',
			revisionId: 'rev',
			etag: null,
			checksumSha256: null,
			now: NOW,
		});
		await harness.db.createShare({
			id: 'shr_x',
			fileId: 'fil_x',
			tokenHash: 'hash-x',
			passwordHash: 'hash-x',
			passwordSalt: null,
			passwordParams: null,
			expiresAt: '2999-01-01T00:00:00.000Z',
			maxDownloads: null,
			now: NOW,
		});
		const app = createApp({
			db: harness.db,
			storage: harness.storage,
			config: { ...harness.config, authPepper: null },
			now: () => new Date(NOW),
		});
		const response = await app.fetch(
			new Request(`${NOW_ORIGIN}/api/v1/public/share/info`, {
				headers: { 'x-share-token': 'token-x' },
			}),
		);
		assert.equal(response.status, 503);
		const body = (await response.json()) as { error: { code: string } };
		assert.equal(body.error.code, 'not_configured');
	});
});

describe('P3-M0 — CSRF/Origin cho endpoint auth thay đổi trạng thái', () => {
	it('POST /auth/password thiếu CSRF => 403', async () => {
		const harness = await createHarness();
		const response = await harness.request('/auth/password', {
			method: 'POST',
			body: {
				currentAuthKey: 'a'.repeat(32),
				newAuthKey: 'b'.repeat(32),
				newAuthVerifierSalt: 'salt-12345678',
				newAuthParams: 'params-12345678',
			},
			headers: { 'x-alkcloud-csrf': '' },
		});
		assert.equal(response.status, 403);
	});

	it('POST /auth/recovery-codes/regenerate thiếu CSRF => 403', async () => {
		const harness = await createHarness();
		const response = await harness.request('/auth/recovery-codes/regenerate', {
			method: 'POST',
			body: {},
			headers: { 'x-alkcloud-csrf': '' },
		});
		assert.equal(response.status, 403);
	});

	it('DELETE /auth/sessions/:id thiếu CSRF => 403', async () => {
		const harness = await createHarness();
		const sessions = (await (
			await harness.request('/auth/sessions')
		).json()) as { sessions: Array<{ id: string }> };
		const response = await harness.request(`/auth/sessions/${sessions.sessions[0]!.id}`, {
			method: 'DELETE',
			headers: { 'x-alkcloud-csrf': '' },
		});
		assert.equal(response.status, 403);
	});

	it('POST /auth/logout với Origin không hợp lệ => 403 (chống CSRF logout)', async () => {
		const harness = await createHarness();
		const response = await harness.request('/auth/logout', {
			method: 'POST',
			body: {},
			headers: { origin: 'https://evil.example' },
		});
		assert.equal(response.status, 403);
	});
});

describe('P3-M0 — audit fallback không làm hỏng thao tác đã thành công', () => {
	it('ghi audit lỗi => request vẫn trả 200 và không lộ chi tiết lỗi', async () => {
		const harness = await createHarness();
		await harness.db.createFile({
			id: 'fil_audit',
			folderId: null,
			name: 'a.txt',
			size: 1,
			contentType: 'text/plain',
			objectKey: 'objects/fil_audit/rev',
			revisionId: 'rev',
			etag: null,
			checksumSha256: null,
			now: NOW,
		});
		const original = harness.db.appendAudit.bind(harness.db);
		(harness.db as unknown as { appendAudit: typeof original }).appendAudit = async () => {
			throw new Error('audit db down');
		};
		const response = await harness.request('/files/fil_audit', {
			method: 'PATCH',
			body: { name: 'b.txt' },
		});
		assert.equal(response.status, 200, 'thao tác đổi tên đã thành công thì không được fail vì audit lỗi');
		(harness.db as unknown as { appendAudit: typeof original }).appendAudit = original;
	});
});

describe('P3-M0 — Content-Disposition chuẩn RFC 5987', () => {
	it('tên file có ký tự ( ) \' * được percent-encode', async () => {
		const harness = await createHarness();
		const name = "a(b)'c*.txt";
		await harness.db.createFile({
			id: 'fil_rfc',
			folderId: null,
			name,
			size: 1,
			contentType: 'text/plain',
			objectKey: 'objects/fil_rfc/rev',
			revisionId: 'rev',
			etag: null,
			checksumSha256: null,
			now: NOW,
		});
		harness.storage.putObject('objects/fil_rfc/rev', {
			size: 1,
			contentType: 'text/plain',
			etag: 'etag',
			body: new TextEncoder().encode('x'),
		});
		const response = await harness.request('/files/fil_rfc/download');
		assert.equal(response.status, 200);
		const disposition = response.headers.get('content-disposition') ?? '';
		assert.match(disposition, /filename\*=UTF-8''a%28b%29%27c%2A\.txt/);
		assert.ok(!disposition.includes("a(b)"), 'ký tự ( ) \' * phải được encode');
	});
});

describe('P3-M0 — lượt tải share không bị mất khi đọc object thất bại', () => {
	it('B2 lỗi => hoàn lại download_count', async () => {
		const harness = await createHarness();
		await harness.db.createFile({
			id: 'fil_fail',
			folderId: null,
			name: 'f.txt',
			size: 1,
			contentType: 'text/plain',
			objectKey: 'objects/fil_fail/rev',
			revisionId: 'rev',
			etag: null,
			checksumSha256: null,
			now: NOW,
		});
		const create = await harness.request('/shares', {
			method: 'POST',
			body: { fileId: 'fil_fail', expiresInDays: 7, maxDownloads: 1 },
		});
		const created = (await create.json()) as { token: string; share: { id: string } };
		const token = created.token;
		const storage = harness.storage;
		const original = storage.presignGet.bind(storage);
		storage.presignGet = async () => {
			throw new Error('B2 unavailable');
		};
		const failed = await harness.request('/public/share/download', {
			headers: { 'x-share-token': token },
		});
		assert.equal(failed.status, 500);
		storage.presignGet = original;
		const row = await harness.db.getShareById(created.share.id);
		assert.equal(row?.downloadCount, 0, 'lượt tải phải được hoàn lại khi tải thất bại');
	});
});

describe('P3-M0 — upload guards', () => {
	it('abort upload session đã COMPLETED => 409 (không ghi đè trạng thái)', async () => {
		const harness = await createHarness();
		const create = await harness.request('/uploads', {
			method: 'POST',
			body: { fileName: 'u.txt', contentType: 'text/plain', totalSize: 2, checksumSha256: null },
		});
		const session = (await create.json()) as { uploadSessionId: string; parts: { url: string }[] };
		const key = harness.storage.keyFromPresignedUrl(session.parts[0]!.url);
		harness.storage.putObject(key, {
			size: 2,
			contentType: 'text/plain',
			etag: 'etag',
			body: new TextEncoder().encode('ok'),
		});
		const complete = await harness.request(`/uploads/${session.uploadSessionId}/complete`, {
			method: 'POST',
			body: { parts: [{ partNumber: 1, etag: 'etag', size: 2 }], checksumSha256: null },
		});
		assert.equal(complete.status, 201);
		const abort = await harness.request(`/uploads/${session.uploadSessionId}`, { method: 'DELETE' });
		assert.equal(abort.status, 409);
		const stored = await harness.db.getUploadSession(session.uploadSessionId);
		assert.equal(stored?.status, 'COMPLETED');
	});

	it('complete vào thư mục đã bị xoá => 409 (không tạo file mồ côi)', async () => {
		const harness = await createHarness();
		const folder = await harness.request('/folders', {
			method: 'POST',
			body: { name: 'target', parentId: null },
		});
		const folderId = ((await folder.json()) as { folder: { id: string } }).folder.id;
		const create = await harness.request('/uploads', {
			method: 'POST',
			body: { fileName: 'u.txt', contentType: 'text/plain', totalSize: 2, folderId, checksumSha256: null },
		});
		const session = (await create.json()) as { uploadSessionId: string; parts: { url: string }[] };
		const key = harness.storage.keyFromPresignedUrl(session.parts[0]!.url);
		harness.storage.putObject(key, {
			size: 2,
			contentType: 'text/plain',
			etag: 'etag',
			body: new TextEncoder().encode('ok'),
		});
		const deleted = await harness.request(`/folders/${folderId}`, { method: 'DELETE' });
		assert.equal(deleted.status, 200);
		const complete = await harness.request(`/uploads/${session.uploadSessionId}/complete`, {
			method: 'POST',
			body: { parts: [{ partNumber: 1, etag: 'etag', size: 2 }], checksumSha256: null },
		});
		assert.equal(complete.status, 409);
	});
});
