import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { createHarness, API, ORIGIN, AUTH_KEY } from './harness.js';
import { checkRange } from '../src/lib/range.js';
import { isServerSideStorageFailure } from '../src/lib/storage-error.js';
import { StorageError } from '@alkcloud/storage';
import { stripPresignedUrls } from '../src/routes/uploads.js';

/**
 * Phase 4 — hồi quy cho các lỗi bảo mật đã sửa (SEC-01 … SEC-15).
 * Mỗi test gắn với 1 mã phát hiện để dễ tra cứu trong SECURITY_AUDIT.md.
 */
describe('SEC-02 — share maxDownloads không bị bypass bằng Range 416', () => {
	it('Range không thỏa mãn bị chặn TRƯỚC khi tăng bộ đếm download', async () => {
		const harness = await createHarness();
		const created = await harness.request('/uploads', {
			method: 'POST',
			body: { fileName: 'range.txt', contentType: 'text/plain', totalSize: 5, checksumSha256: null },
		});
		const session = (await created.json()) as {
			uploadSessionId: string;
			parts: Array<{ url: string }>;
		};
		const key = harness.storage.keyFromPresignedUrl(session.parts[0]!.url);
		harness.storage.putObject(key, {
			size: 5,
			contentType: 'text/plain',
			etag: 'etag-range',
			body: new TextEncoder().encode('hello'),
		});
		const completed = await harness.request(`/uploads/${session.uploadSessionId}/complete`, {
			method: 'POST',
			body: { parts: [{ partNumber: 1, etag: 'etag-range', size: 5 }], checksumSha256: null },
		});
		assert.equal(completed.status, 201);
		const fileId = (await harness.request('/files')).headers ? null : null;
		void fileId;

		const files = (await (await harness.request('/files')).json()) as { files: Array<{ id: string }> };
		const shareResponse = await harness.request('/shares', {
			method: 'POST',
			body: { fileId: files.files[0]!.id, expiresInDays: 1, maxDownloads: 1 },
		});
		assert.equal(shareResponse.status, 201);
		const share = (await shareResponse.json()) as { share: { id: string }; token: string };

		// Range ngoài EOF ⇒ 416, KHÔNG được tiêu tốn lượt tải.
		const rangeResponse = await harness.request('/public/share/download', {
			headers: { 'x-share-token': share.token, range: 'bytes=999999999-' },
		});
		assert.equal(rangeResponse.status, 416, 'Range không thỏa mãn phải trả 416');

		// Bộ đếm phải vẫn = 0 (chưa tải lần nào).
		const info = (await (
			await harness.request('/public/share/info', { headers: { 'x-share-token': share.token } })
		).json()) as { share: { downloadCount: number } };
		assert.equal(info.share.downloadCount, 0, 'Range 416 KHÔNG được tiêu tốn lượt tải');

		// Lượt tải hợp lệ đầu tiên vẫn phải thành công.
		const ok = await harness.request('/public/share/download', {
			headers: { 'x-share-token': share.token },
		});
		assert.equal(ok.status, 200);

		// Lượt thứ 2 vượt giới hạn ⇒ 403.
		const second = await harness.request('/public/share/download', {
			headers: { 'x-share-token': share.token },
		});
		assert.equal(second.status, 403, 'maxDownloads=1 ⇒ lần 2 phải bị chặn');
	});

	it('lỗi 5xx từ storage ĐƯỢC hoàn lượt tải (không mất lượt oan)', () => {
		assert.equal(isServerSideStorageFailure(new StorageError('boom', 503)), true);
		assert.equal(isServerSideStorageFailure(new StorageError('timeout')), true);
		assert.equal(isServerSideStorageFailure(new StorageError('range', 416)), false);
		assert.equal(isServerSideStorageFailure(new StorageError('forbidden', 403)), false);
	});
});

describe('SEC-02 (lib) — checkRange', () => {
	it('Range hợp lệ ⇒ satisfiable', () => {
		assert.equal(checkRange('bytes=0-4', 5).satisfiable, true);
		assert.equal(checkRange('bytes=2-', 5).satisfiable, true);
		assert.equal(checkRange('bytes=-2', 5).satisfiable, true);
		assert.equal(checkRange(null, 5).satisfiable, true);
	});

	it('Range ngoài EOF ⇒ không thỏa mãn', () => {
		assert.equal(checkRange('bytes=5-', 5).satisfiable, false);
		assert.equal(checkRange('bytes=999999999-', 5).satisfiable, false);
		assert.equal(checkRange('bytes=3-1', 5).satisfiable, false);
	});

	it('Range không parse được ⇒ không xác định (KHÔNG tiêu tốn lượt tải)', () => {
		assert.equal(checkRange('bytes=0-1,3-4', 5).satisfiable, null);
		assert.equal(checkRange('items=0-1', 5).satisfiable, null);
	});
});

describe('SEC-06/SEC-07 — auth endpoint chặn Origin lạ', () => {
	it('POST /auth/login với Origin không hợp lệ ⇒ 403', async () => {
		const harness = await createHarness();
		const response = await harness.request('/auth/login', {
			method: 'POST',
			body: { email: 'owner@alkcloud.test', authKey: AUTH_KEY },
			headers: { origin: 'https://evil.example' },
			cookie: '',
		});
		assert.equal(response.status, 403);
	});

	it('POST /auth/login KHÔNG có Origin ⇒ 403 (chặn login CSRF)', async () => {
		const harness = await createHarness();
		const response = await harness.request('/auth/login', {
			method: 'POST',
			body: { email: 'owner@alkcloud.test', authKey: AUTH_KEY },
			headers: { origin: '' },
			cookie: '',
		});
		assert.equal(response.status, 403);
	});

	it('POST /auth/recovery-login với Origin không hợp lệ ⇒ 403', async () => {
		const harness = await createHarness();
		const response = await harness.request('/auth/recovery-login', {
			method: 'POST',
			body: { email: 'owner@alkcloud.test', code: 'ABCD-EFGH-IJKL' },
			headers: { origin: 'https://evil.example' },
			cookie: '',
		});
		assert.equal(response.status, 403);
	});

	it('POST /auth/bootstrap với Origin không hợp lệ ⇒ 403', async () => {
		const harness = await createHarness({ bootstrap: false });
		const response = await harness.request('/auth/bootstrap', {
			method: 'POST',
			body: {
				setupToken: 'setup-token-0123456789abcdef',
				email: 'owner@alkcloud.test',
				authKey: AUTH_KEY,
				authVerifierSalt: 'salt-12345678',
				authParams: 'params-12345678',
			},
			headers: { origin: 'https://evil.example' },
			cookie: '',
		});
		assert.equal(response.status, 403);
	});
});

describe('SEC-06 — recovery-login bị rate limit', () => {
	it('thử recovery code sai 5 lần ⇒ lần 6 bị 429', async () => {
		const harness = await createHarness();
		const statuses: number[] = [];
		for (let attempt = 0; attempt < 6; attempt++) {
			const response = await harness.request('/auth/recovery-login', {
				method: 'POST',
				body: { email: 'owner@alkcloud.test', code: 'AAAA-BBBB-CCCC' },
				cookie: '',
			});
			statuses.push(response.status);
		}
		assert.equal(statuses[0], 401);
		assert.equal(statuses[5], 429, 'lần 6 phải bị rate limit');
	});
});

describe('SEC-08 — GET /files/:id không lộ metadata file trong trash', () => {
	it('file trong trash ⇒ 404', async () => {
		const harness = await createHarness();
		const created = await harness.request('/uploads', {
			method: 'POST',
			body: { fileName: 'secret.txt', contentType: 'text/plain', totalSize: 5, checksumSha256: null },
		});
		const session = (await created.json()) as {
			uploadSessionId: string;
			parts: Array<{ url: string }>;
		};
		const key = harness.storage.keyFromPresignedUrl(session.parts[0]!.url);
		harness.storage.putObject(key, {
			size: 5,
			contentType: 'text/plain',
			etag: 'etag-secret',
			body: new TextEncoder().encode('hello'),
		});
		await harness.request(`/uploads/${session.uploadSessionId}/complete`, {
			method: 'POST',
			body: { parts: [{ partNumber: 1, etag: 'etag-secret', size: 5 }], checksumSha256: null },
		});
		const list = (await (await harness.request('/files')).json()) as { files: Array<{ id: string }> };
		const fileId = list.files[0]!.id;

		const before = await harness.request(`/files/${fileId}`);
		assert.equal(before.status, 200);
		const beforeBody = (await before.json()) as { file: Record<string, unknown> };
		assert.equal(beforeBody.file.objectKey, undefined, 'KHÔNG trả objectKey cho client');
		assert.equal(beforeBody.file.etag, undefined, 'KHÔNG trả etag cho client');

		await harness.request(`/files/${fileId}`, { method: 'DELETE' });
		const after = await harness.request(`/files/${fileId}`);
		assert.equal(after.status, 404, 'file trong trash phải trả 404');
	});
});

describe('SEC-12 — presigned URL không được lưu vào D1', () => {
	it('stripPresignedUrls loại bỏ url khỏi parts', () => {
		const stripped = stripPresignedUrls({
			uploadSessionId: 'upl_1',
			parts: [{ partNumber: 1, url: 'https://b2.example/presigned?sig=secret', headers: {}, expiresAt: 'x' }],
		});
		const parts = stripped.parts as Array<Record<string, unknown>>;
		assert.equal(parts[0]?.url, undefined);
		assert.equal(parts[0]?.partNumber, 1);
	});
});

describe('SEC-03 — hash mật khẩu share dùng salt per-share', () => {
	it('2 share CÙNG mật khẩu nhưng khác salt ⇒ hash khác nhau', async () => {
		const harness = await createHarness();
		const created = await harness.request('/uploads', {
			method: 'POST',
			body: { fileName: 'shared.txt', contentType: 'text/plain', totalSize: 5, checksumSha256: null },
		});
		const session = (await created.json()) as {
			uploadSessionId: string;
			parts: Array<{ url: string }>;
		};
		const key = harness.storage.keyFromPresignedUrl(session.parts[0]!.url);
		harness.storage.putObject(key, {
			size: 5,
			contentType: 'text/plain',
			etag: 'etag-shared',
			body: new TextEncoder().encode('hello'),
		});
		await harness.request(`/uploads/${session.uploadSessionId}/complete`, {
			method: 'POST',
			body: { parts: [{ partNumber: 1, etag: 'etag-shared', size: 5 }], checksumSha256: null },
		});
		const list = (await (await harness.request('/files')).json()) as { files: Array<{ id: string }> };
		const fileId = list.files[0]!.id;

		const verifier = 'a'.repeat(64);
		const make = async (salt: string) => {
			const response = await harness.request('/shares', {
				method: 'POST',
				body: {
					fileId,
					expiresInDays: 1,
					passwordVerifier: verifier,
					passwordSalt: salt,
					passwordParams: 'sha256-v1',
				},
			});
			assert.equal(response.status, 201);
			return (await response.json()) as { share: { id: string }; token: string };
		};

		const first = await make('salt-aaaaaaaa');
		const second = await make('salt-bbbbbbbb');
		const hashOf = async (id: string) => {
			const share = await harness.db.getShareById(id);
			return share?.passwordHash;
		};
		assert.notEqual(await hashOf(first.share.id), await hashOf(second.share.id), 'hash phải khác nhau');

		// Mở khoá bằng verifier đúng vẫn phải hoạt động cho cả 2 share.
		for (const share of [first, second]) {
			const unlock = await harness.request('/public/share/unlock', {
				method: 'POST',
				body: { passwordVerifier: verifier },
				headers: { 'x-share-token': share.token },
			});
			assert.equal(unlock.status, 200, 'unlock với verifier + salt đúng phải thành công');
		}
	});

	it('mở khoá SAI verifier ⇒ 403', async () => {
		const harness = await createHarness();
		const created = await harness.request('/uploads', {
			method: 'POST',
			body: { fileName: 'pw.txt', contentType: 'text/plain', totalSize: 5, checksumSha256: null },
		});
		const session = (await created.json()) as {
			uploadSessionId: string;
			parts: Array<{ url: string }>;
		};
		const key = harness.storage.keyFromPresignedUrl(session.parts[0]!.url);
		harness.storage.putObject(key, {
			size: 5,
			contentType: 'text/plain',
			etag: 'etag-pw',
			body: new TextEncoder().encode('hello'),
		});
		await harness.request(`/uploads/${session.uploadSessionId}/complete`, {
			method: 'POST',
			body: { parts: [{ partNumber: 1, etag: 'etag-pw', size: 5 }], checksumSha256: null },
		});
		const list = (await (await harness.request('/files')).json()) as { files: Array<{ id: string }> };
		const shareResponse = await harness.request('/shares', {
			method: 'POST',
			body: {
				fileId: list.files[0]!.id,
				expiresInDays: 1,
				passwordVerifier: 'b'.repeat(64),
				passwordSalt: 'salt-cccccccc',
				passwordParams: 'sha256-v1',
			},
		});
		const share = (await shareResponse.json()) as { token: string };
		const unlock = await harness.request('/public/share/unlock', {
			method: 'POST',
			body: { passwordVerifier: 'c'.repeat(64) },
			headers: { 'x-share-token': share.token },
		});
		assert.equal(unlock.status, 403);
	});
});

describe('SEC-05 — xoá folder không vượt giới hạn subrequest', () => {
	it('xoá folder có nhiều thư mục con ⇒ xoá TOÀN BỘ subtree bằng 1 câu lệnh', async () => {
		const harness = await createHarness();
		const root = await harness.request('/folders', {
			method: 'POST',
			body: { name: 'root-folder', parentId: null },
		});
		assert.equal(root.status, 201);
		const rootId = ((await root.json()) as { folder: { id: string } }).folder.id;

		const children: string[] = [];
		for (let index = 0; index < 60; index++) {
			const child = await harness.request('/folders', {
				method: 'POST',
				body: { name: `child-${index}`, parentId: rootId },
			});
			assert.equal(child.status, 201);
			children.push(((await child.json()) as { folder: { id: string } }).folder.id);
		}

		const deleted = await harness.request(`/folders/${rootId}`, { method: 'DELETE' });
		assert.equal(deleted.status, 200, 'xoá folder 60 con không được lỗi (giới hạn subrequest)');
		const body = (await deleted.json()) as { deleted: number };
		assert.equal(body.deleted, 61, 'phải xoá đủ root + 60 con');

		// Không folder nào còn "đang hoạt động".
		const trash = (await (await harness.request('/folders/trash')).json()) as {
			folders: Array<{ id: string }>;
		};
		const trashedIds = new Set(trash.folders.map((folder) => folder.id));
		for (const id of [rootId, ...children]) {
			assert.ok(trashedIds.has(id), `folder ${id} phải nằm trong trash`);
		}
	});
});

describe('SEC-09 — purge chỉ xoá file VẪN đang trong trash', () => {
	it('file đang hoạt động ⇒ deleteFileRowIfStillTrashed KHÔNG xoá', async () => {
		const harness = await createHarness();
		const created = await harness.request('/uploads', {
			method: 'POST',
			body: { fileName: 'purge-guard.txt', contentType: 'text/plain', totalSize: 5, checksumSha256: null },
		});
		const session = (await created.json()) as {
			uploadSessionId: string;
			parts: Array<{ url: string }>;
		};
		const key = harness.storage.keyFromPresignedUrl(session.parts[0]!.url);
		harness.storage.putObject(key, {
			size: 5,
			contentType: 'text/plain',
			etag: 'etag-purge',
			body: new TextEncoder().encode('hello'),
		});
		await harness.request(`/uploads/${session.uploadSessionId}/complete`, {
			method: 'POST',
			body: { parts: [{ partNumber: 1, etag: 'etag-purge', size: 5 }], checksumSha256: null },
		});
		const list = (await (await harness.request('/files')).json()) as { files: Array<{ id: string }> };
		const fileId = list.files[0]!.id;

		// File ĐANG HOẠT ĐỘNG (chưa vào trash) ⇒ xoá có điều kiện phải từ chối.
		const deleted = await harness.db.deleteFileRowIfStillTrashed(fileId, '2026-01-15T10:00:00.000Z');
		assert.equal(deleted, false, 'file đang hoạt động KHÔNG được xoá');
		assert.ok(await harness.db.getFile(fileId), 'file phải còn nguyên');

		// Vào trash + hết hạn purge ⇒ xoá được.
		await harness.request(`/files/${fileId}`, { method: 'DELETE' });
		await harness.db.sqlDriver.run(
			"UPDATE files SET purge_after = '2020-02-01T00:00:00.000Z' WHERE id = ?",
			[fileId],
		);
		const deletedExpired = await harness.db.deleteFileRowIfStillTrashed(fileId, '2026-01-15T10:00:00.000Z');
		assert.equal(deletedExpired, true, 'file đã hết hạn purge phải xoá được');
		assert.equal(await harness.db.getFile(fileId), null);
	});

	it('file trong trash CHƯA hết hạn purge ⇒ không xoá', async () => {
		const harness = await createHarness();
		const created = await harness.request('/uploads', {
			method: 'POST',
			body: { fileName: 'purge-early.txt', contentType: 'text/plain', totalSize: 5, checksumSha256: null },
		});
		const session = (await created.json()) as {
			uploadSessionId: string;
			parts: Array<{ url: string }>;
		};
		const key = harness.storage.keyFromPresignedUrl(session.parts[0]!.url);
		harness.storage.putObject(key, {
			size: 5,
			contentType: 'text/plain',
			etag: 'etag-early',
			body: new TextEncoder().encode('hello'),
		});
		await harness.request(`/uploads/${session.uploadSessionId}/complete`, {
			method: 'POST',
			body: { parts: [{ partNumber: 1, etag: 'etag-early', size: 5 }], checksumSha256: null },
		});
		const list = (await (await harness.request('/files')).json()) as { files: Array<{ id: string }> };
		const fileId = list.files[0]!.id;
		await harness.request(`/files/${fileId}`, { method: 'DELETE' });

		const deleted = await harness.db.deleteFileRowIfStillTrashed(fileId, '2026-01-15T10:00:00.000Z');
		assert.equal(deleted, false, 'chưa hết hạn purge ⇒ KHÔNG xoá');
		assert.ok(await harness.db.getFile(fileId));
	});
});
