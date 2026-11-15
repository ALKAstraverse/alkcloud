import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { createHarness, type Harness } from './harness.js';

/**
 * Thùng rác — owner được xoá vĩnh viễn NGAY, không phải chờ retention 30 ngày.
 * `purge_after` chỉ là mốc cron tự dọn; UI/API phải cho xoá ngay.
 */

const CLOCK = new Date('2026-01-15T10:00:00.000Z');

async function uploadFile(harness: Harness, name: string, body: string, folderId: string | null = null): Promise<string> {
	const bytes = new TextEncoder().encode(body);
	const created = await harness.request('/uploads', {
		method: 'POST',
		body: {
			fileName: name,
			contentType: 'text/plain',
			totalSize: bytes.byteLength,
			checksumSha256: null,
			folderId,
		},
	});
	assert.equal(created.status, 201);
	const session = (await created.json()) as { uploadSessionId: string; parts: Array<{ url: string }> };
	const key = harness.storage.keyFromPresignedUrl(session.parts[0]!.url);
	harness.storage.putObject(key, {
		size: bytes.byteLength,
		contentType: 'text/plain',
		etag: `etag-${name}`,
		body: bytes,
	});
	const completed = await harness.request(`/uploads/${session.uploadSessionId}/complete`, {
		method: 'POST',
		body: { parts: [{ partNumber: 1, etag: `etag-${name}`, size: bytes.byteLength }], checksumSha256: null },
	});
	assert.equal(completed.status, 201);
	return ((await completed.json()) as { file: { id: string } }).file.id;
}

async function createFolder(harness: Harness, name: string, parentId: string | null = null): Promise<string> {
	const response = await harness.request('/folders', { method: 'POST', body: { name, parentId } });
	assert.equal(response.status, 201);
	return ((await response.json()) as { folder: { id: string } }).folder.id;
}

describe('Thùng rác — xoá vĩnh viễn ngay', () => {
	it('file: purge ngay sau khi xoá (purge_after còn ~30 ngày) ⇒ 200 và xoá object', async () => {
		const harness = await createHarness();
		const fileId = await uploadFile(harness, 'xoa-ngay.txt', 'hello');

		const deleted = await harness.request(`/files/${fileId}`, { method: 'DELETE' });
		assert.equal(deleted.status, 200);

		const row = await harness.db.getFile(fileId);
		assert.ok(row?.purgeAfter, 'file trong trash phải có purgeAfter');
		assert.ok(
			new Date(row!.purgeAfter!).getTime() > CLOCK.getTime(),
			'purge_after phải ở tương lai (chưa hết retention)',
		);
		assert.equal(harness.storage.objects.size, 1);

		const purge = await harness.request(`/files/${fileId}/purge`, { method: 'DELETE' });
		assert.equal(purge.status, 200, `purge ngay phải 200, nhận ${purge.status}: ${await purge.clone().text()}`);
		assert.equal(harness.storage.objects.size, 0, 'purge phải xoá object khỏi storage');
		assert.equal((await harness.request(`/files/${fileId}`)).status, 404, 'file đã purge không còn tồn tại');

		const audit = (await (await harness.request('/system/audit?limit=20')).json()) as {
			events: Array<{ action: string }>;
		};
		assert.ok(audit.events.some((event) => event.action === 'file.purge'), 'phải ghi audit file.purge');
	});

	it('folder: chặn khi còn file trong cây, cho phép sau khi purge hết file', async () => {
		const harness = await createHarness();
		const rootId = await createFolder(harness, 'A');
		const childId = await createFolder(harness, 'B', rootId);
		const fileId = await uploadFile(harness, 'trong-thu-muc.txt', 'abc', childId);

		const deleted = await harness.request(`/folders/${rootId}`, { method: 'DELETE' });
		assert.equal(deleted.status, 200);

		const blocked = await harness.request(`/folders/${rootId}/purge`, { method: 'DELETE' });
		assert.equal(blocked.status, 409, `purge folder khi còn file phải 409, nhận ${blocked.status}`);

		const purgedFile = await harness.request(`/files/${fileId}/purge`, { method: 'DELETE' });
		assert.equal(purgedFile.status, 200, `purge file phải 200, nhận ${purgedFile.status}`);

		const purgedFolder = await harness.request(`/folders/${rootId}/purge`, { method: 'DELETE' });
		assert.equal(
			purgedFolder.status,
			200,
			`purge folder sau khi hết file phải 200, nhận ${purgedFolder.status}: ${await purgedFolder.clone().text()}`,
		);

		const trash = (await (await harness.request('/folders/trash')).json()) as { folders: unknown[] };
		assert.equal(trash.folders.length, 0, 'trash folder phải trống (cascade dọn folder con)');

		const audit = (await (await harness.request('/system/audit?limit=20')).json()) as {
			events: Array<{ action: string }>;
		};
		assert.ok(audit.events.some((event) => event.action === 'folder.purge'), 'phải ghi audit folder.purge');
	});
});
