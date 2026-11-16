import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import type { Harness } from './harness.js';
import { createHarness } from './harness.js';

const NOW = '2026-01-15T10:00:00.000Z';

async function seedFolder(harness: Harness, id: string, parentId: string | null = null): Promise<string> {
	await harness.db.createFolder({
		id,
		parentId,
		name: id,
		depth: parentId ? 1 : 0,
		now: NOW,
	});
	return id;
}

async function seedFile(harness: Harness, id: string, folderId: string | null, name = 'a.txt'): Promise<string> {
	await harness.db.createFile({
		id,
		folderId,
		name,
		size: 4,
		contentType: 'text/plain',
		objectKey: `objects/${id}/rev`,
		revisionId: 'rev',
		etag: 'etag',
		checksumSha256: null,
		now: NOW,
	});
	harness.storage.putObject(`objects/${id}/rev`, {
		size: 4,
		contentType: 'text/plain',
		etag: 'etag',
		body: new TextEncoder().encode('data'),
	});
	return id;
}

async function createFolderShare(harness: Harness, folderId: string, extra: Record<string, unknown> = {}) {
	const response = await harness.request('/shares', {
		method: 'POST',
		body: { folderId, expiresInDays: 7, maxDownloads: null, ...extra },
	});
	assert.equal(response.status, 201, `tạo share thư mục phải 201, nhận ${response.status}`);
	return (await response.json()) as {
		share: { id: string; folderId: string | null; fileId: string | null };
		token: string;
	};
}

describe('share thư mục', () => {
	it('tạo share thư mục + info trả về kind=folder', async () => {
		const harness = await createHarness();
		const folderId = await seedFolder(harness, 'fol_1');
		const share = await createFolderShare(harness, folderId);
		assert.equal(share.share.folderId, folderId);
		assert.equal(share.share.fileId, null);

		const info = await harness.request('/public/share/info', {
			headers: { 'x-share-token': share.token },
		});
		assert.equal(info.status, 200);
		const body = (await info.json()) as { share: { kind: string; folderName: string } };
		assert.equal(body.share.kind, 'folder');
		assert.equal(body.share.folderName, 'fol_1');
	});

	it('danh sách nội dung thư mục chia sẻ + tải tệp bên trong', async () => {
		const harness = await createHarness();
		const folderId = await seedFolder(harness, 'fol_root');
		const childId = await seedFolder(harness, 'fol_child', folderId);
		const fileId = await seedFile(harness, 'fil_1', folderId, 'trong-thu-muc.txt');
		await seedFile(harness, 'fil_ngoai', null, 'ngoai-thu-muc.txt');
		const share = await createFolderShare(harness, folderId);

		const list = await harness.request('/public/share/folder', {
			headers: { 'x-share-token': share.token },
		});
		assert.equal(list.status, 200);
		const body = (await list.json()) as {
			folder: { id: string };
			isRoot: boolean;
			folders: Array<{ id: string }>;
			files: Array<{ id: string }>;
		};
		assert.equal(body.folder.id, folderId);
		assert.equal(body.isRoot, true);
		assert.deepEqual(body.folders.map((folder) => folder.id), [childId]);
		assert.deepEqual(body.files.map((file) => file.id), [fileId]);

		// Tải tệp trong thư mục được chia sẻ ⇒ 302 presigned (không stream qua Worker).
		const download = await harness.request(`/public/share/download?fileId=${fileId}`, {
			headers: { 'x-share-token': share.token },
			followPresign: false,
		});
		assert.equal(download.status, 302);
		assert.match(download.headers.get('location') ?? '', /^https:\/\/mock\.invalid\/get\//);

		// Tệp NGOÀI cây thư mục được chia sẻ ⇒ 404 (không lộ).
		const outside = await harness.request('/public/share/download?fileId=fil_ngoai', {
			headers: { 'x-share-token': share.token },
		});
		assert.equal(outside.status, 404);

		// Xem thư mục con trong cây ⇒ 200; ngoài cây ⇒ 404.
		const child = await harness.request(`/public/share/folder?path=${childId}`, {
			headers: { 'x-share-token': share.token },
		});
		assert.equal(child.status, 200);
	});

	it('share thư mục có mật khẩu ⇒ chưa mở khoá thì không xem được nội dung', async () => {
		const harness = await createHarness();
		const folderId = await seedFolder(harness, 'fol_lock');
		await seedFile(harness, 'fil_lock', folderId, 'khoa.txt');
		const verifier = 'a'.repeat(64);
		const share = await createFolderShare(harness, folderId, {
			passwordVerifier: verifier,
			passwordSalt: 'salt-12345678',
			passwordParams: 'sha256-v1',
		});

		const locked = await harness.request('/public/share/folder', {
			headers: { 'x-share-token': share.token },
		});
		assert.equal(locked.status, 403);

		const unlock = await harness.request('/public/share/unlock', {
			method: 'POST',
			headers: { 'x-share-token': share.token },
			body: { passwordVerifier: verifier },
		});
		assert.equal(unlock.status, 200);
		const unlockedBody = (await unlock.json()) as { grant: string };
		const unlocked = await harness.request('/public/share/folder', {
			headers: { 'x-share-token': share.token, 'x-share-grant': unlockedBody.grant },
		});
		assert.equal(unlocked.status, 200);
	});

	it('purge thư mục ⇒ share của thư mục bị thu hồi', async () => {
		const harness = await createHarness();
		const folderId = await seedFolder(harness, 'fol_purge');
		const share = await createFolderShare(harness, folderId);

		// Xoá thư mục vào thùng rác rồi purge vĩnh viễn.
		const deleted = await harness.request(`/folders/${folderId}`, { method: 'DELETE' });
		assert.equal(deleted.status, 200);
		const purged = await harness.request(`/folders/${folderId}/purge`, { method: 'DELETE' });
		assert.equal(purged.status, 200);

		const info = await harness.request('/public/share/info', {
			headers: { 'x-share-token': share.token },
		});
		assert.equal(info.status, 404, 'share thư mục phải chết sau khi purge thư mục');
	});

	it('tạo share với cả fileId và folderId ⇒ 400', async () => {
		const harness = await createHarness();
		const folderId = await seedFolder(harness, 'fol_x');
		const fileId = await seedFile(harness, 'fil_x', folderId);
		const response = await harness.request('/shares', {
			method: 'POST',
			body: { fileId, folderId, expiresInDays: 7 },
		});
		assert.equal(response.status, 400);
	});
});
