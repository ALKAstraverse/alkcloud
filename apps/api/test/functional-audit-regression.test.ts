import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { createHarness, type Harness } from './harness.js';

const NOW = '2026-01-15T10:00:00.000Z';

interface SeedOptions {
	id: string;
	name: string;
	folderId?: string | null;
	size?: number;
}

async function seedFile(harness: Harness, options: SeedOptions): Promise<string> {
	const size = options.size ?? 4;
	await harness.db.createFile({
		id: options.id,
		folderId: options.folderId ?? null,
		name: options.name,
		size,
		contentType: 'text/plain',
		objectKey: `objects/${options.id}/rev`,
		revisionId: 'rev',
		etag: 'etag',
		checksumSha256: null,
		now: NOW,
	});
	harness.storage.putObject(`objects/${options.id}/rev`, {
		size,
		contentType: 'text/plain',
		etag: 'etag',
		body: new TextEncoder().encode('data'),
	});
	return options.id;
}

async function seedFolder(harness: Harness, id: string, name: string, parentId: string | null = null) {
	await harness.db.createFolder({ id, parentId, name, depth: parentId ? 1 : 0, now: NOW });
	return id;
}

/**
 * Regression test cho các lỗi phát hiện trong functional audit (Phase 9).
 * Chạy in-process (không cần stack) ⇒ nằm trong `npm test` của CI.
 */
describe('functional audit — move file không được lặng lẽ về root', () => {
	it('body rỗng ⇒ 400 và file giữ nguyên thư mục', async () => {
		const harness = await createHarness();
		const folderId = await seedFolder(harness, 'fld_move_src', 'src');
		const fileId = await seedFile(harness, { id: 'fil_move_src', name: 'a.txt', folderId });

		const response = await harness.request(`/files/${fileId}/move`, { method: 'POST', body: {} });
		assert.equal(response.status, 400, `body rỗng phải 400, nhận ${response.status}`);

		const file = await harness.db.getFile(fileId);
		assert.equal(file?.folderId, folderId, 'file không được bị chuyển về gốc khi body sai');
	});

	it('sai tên field (targetFolderId) ⇒ 400', async () => {
		const harness = await createHarness();
		const folderId = await seedFolder(harness, 'fld_move_typo', 'src');
		const fileId = await seedFile(harness, { id: 'fil_move_typo', name: 'b.txt', folderId });

		const response = await harness.request(`/files/${fileId}/move`, {
			method: 'POST',
			body: { targetFolderId: 'fld_move_dst' },
		});
		assert.equal(response.status, 400, `sai field phải 400, nhận ${response.status}`);
	});

	it('folderId hợp lệ ⇒ 200 và file chuyển đúng chỗ', async () => {
		const harness = await createHarness();
		await seedFolder(harness, 'fld_move_src2', 'src');
		const destination = await seedFolder(harness, 'fld_move_dst2', 'dst');
		const fileId = await seedFile(harness, { id: 'fil_move_ok', name: 'c.txt', folderId: 'fld_move_src2' });

		const response = await harness.request(`/files/${fileId}/move`, {
			method: 'POST',
			body: { folderId: destination },
		});
		assert.equal(response.status, 200, `move hợp lệ phải 200, nhận ${response.status}`);
		const file = await harness.db.getFile(fileId);
		assert.equal(file?.folderId, destination);
	});
});

describe('functional audit — optimistic concurrency (version)', () => {
	it('rename file với version sai ⇒ 409, version đúng ⇒ 200', async () => {
		const harness = await createHarness();
		const fileId = await seedFile(harness, { id: 'fil_ver', name: 'v.txt' });

		const stale = await harness.request(`/files/${fileId}`, {
			method: 'PATCH',
			body: { name: 'v2.txt', version: 99 },
		});
		assert.equal(stale.status, 409, `version sai phải 409, nhận ${stale.status}`);

		const current = await harness.db.getFile(fileId);
		const ok = await harness.request(`/files/${fileId}`, {
			method: 'PATCH',
			body: { name: 'v2.txt', version: current?.version ?? 0 },
		});
		assert.equal(ok.status, 200, `version đúng phải 200, nhận ${ok.status}`);
	});

	it('rename folder với version sai ⇒ 409', async () => {
		const harness = await createHarness();
		await seedFolder(harness, 'fld_ver', 'old');
		const response = await harness.request('/folders/fld_ver', {
			method: 'PATCH',
			body: { name: 'new', version: 42 },
		});
		assert.equal(response.status, 409, `version sai phải 409, nhận ${response.status}`);
	});

	it('move file với version sai ⇒ 409', async () => {
		const harness = await createHarness();
		await seedFolder(harness, 'fld_ver_dst', 'dst');
		const fileId = await seedFile(harness, { id: 'fil_ver_move', name: 'm.txt' });
		const response = await harness.request(`/files/${fileId}/move`, {
			method: 'POST',
			body: { folderId: 'fld_ver_dst', version: 7 },
		});
		assert.equal(response.status, 409, `version sai phải 409, nhận ${response.status}`);
	});

	it('client không gửi version ⇒ vẫn hoạt động (tương thích ngược)', async () => {
		const harness = await createHarness();
		const fileId = await seedFile(harness, { id: 'fil_ver_none', name: 'n.txt' });
		const response = await harness.request(`/files/${fileId}`, {
			method: 'PATCH',
			body: { name: 'n2.txt' },
		});
		assert.equal(response.status, 200, `không gửi version phải vẫn 200, nhận ${response.status}`);
	});
});

describe('functional audit — phân trang danh sách file', () => {
	it('cursor duyệt hết file, không trùng không thiếu', async () => {
		const harness = await createHarness();
		const total = 5;
		for (let index = 0; index < total; index += 1) {
			await seedFile(harness, { id: `fil_page_${index}`, name: `page-${index}.txt` });
		}

		const seen: string[] = [];
		let cursor: string | null = null;
		let pages = 0;
		do {
			const query = new URLSearchParams({ limit: '2' });
			if (cursor) query.set('cursor', cursor);
			const response = await harness.request(`/files?${query.toString()}`);
			assert.equal(response.status, 200);
			const body = (await response.json()) as {
				files: Array<{ id: string }>;
				nextCursor?: string | null;
			};
			for (const file of body.files) seen.push(file.id);
			cursor = body.nextCursor ?? null;
			pages += 1;
			assert.ok(pages < 10, 'cursor không tiến ⇒ lặp vô hạn');
		} while (cursor);

		assert.equal(seen.length, total, `phải thấy đủ ${total} file, thấy ${seen.length}`);
		assert.equal(new Set(seen).size, total, 'không được lặp file giữa các trang');
	});

	it('trashed=true trả về cả file nằm trong thư mục', async () => {
		const harness = await createHarness();
		const folderId = await seedFolder(harness, 'fld_trash_scope', 'trashed-folder');
		await seedFile(harness, { id: 'fil_trash_root', name: 'root.txt' });
		await seedFile(harness, { id: 'fil_trash_nested', name: 'nested.txt', folderId });
		await harness.request('/files/fil_trash_root', { method: 'DELETE' });
		await harness.request('/files/fil_trash_nested', { method: 'DELETE' });

		const response = await harness.request('/files?trashed=true&limit=200');
		assert.equal(response.status, 200);
		const body = (await response.json()) as { files: Array<{ id: string }> };
		const ids = body.files.map((file) => file.id);
		assert.ok(ids.includes('fil_trash_root'), 'file ở gốc phải có trong trash');
		assert.ok(ids.includes('fil_trash_nested'), 'file trong thư mục phải có trong trash');
	});
});

describe('functional audit — /system/audit limit', () => {
	it('limit không phải số nguyên ⇒ 400 (không phải 500)', async () => {
		const harness = await createHarness();
		const response = await harness.request('/system/audit?limit=1.5');
		assert.equal(response.status, 400, `limit=1.5 phải 400, nhận ${response.status}`);
	});

	it('limit hợp lệ ⇒ 200', async () => {
		const harness = await createHarness();
		const response = await harness.request('/system/audit?limit=10');
		assert.equal(response.status, 200);
	});
});

describe('functional audit — multipart integrity', () => {
	it('tổng bytes part không khớp totalSize ⇒ 400', async () => {
		const harness = await createHarness();
		const declared = 101 * 1024 * 1024;
		const created = await harness.request('/uploads', {
			method: 'POST',
			body: {
				fileName: 'big.bin',
				contentType: 'application/octet-stream',
				totalSize: declared,
				checksumSha256: null,
				folderId: null,
			},
		});
		assert.equal(created.status, 201, `tạo session phải 201, nhận ${created.status}`);
		const session = (await created.json()) as {
			uploadSessionId: string;
			mode: string;
			uploadId: string;
			partCount: number;
		};
		assert.equal(session.mode, 'multipart');

		// Client khai 101MB nhưng chỉ gửi 2 part, mỗi part 1 byte.
		harness.storage.putPart(session.uploadId, 1, 1);
		harness.storage.putPart(session.uploadId, 2, 1);

		const response = await harness.request(`/uploads/${session.uploadSessionId}/complete`, {
			method: 'POST',
			body: {
				parts: [
					{ partNumber: 1, etag: 'etag-1', size: 1 },
					{ partNumber: 2, etag: 'etag-2', size: 1 },
				],
				uploadId: session.uploadId,
				checksumSha256: null,
			},
		});
		assert.equal(response.status, 400, `tổng bytes lệch phải 400, nhận ${response.status}`);
		const files = await harness.db.listFiles({ limit: 10, offset: 0 });
		assert.equal(files.length, 0, 'không được tạo file khi tổng bytes lệch');
	});

	it('tổng bytes khớp ⇒ 201 và file có đúng kích thước', async () => {
		const harness = await createHarness();
		const partSize = 64 * 1024 * 1024;
		// > 100MB ⇒ multipart (ngưỡng MULTIPART_THRESHOLD_BYTES), 2 part.
		const declared = partSize + 40 * 1024 * 1024;
		const created = await harness.request('/uploads', {
			method: 'POST',
			body: {
				fileName: 'big-ok.bin',
				contentType: 'application/octet-stream',
				totalSize: declared,
				checksumSha256: null,
				folderId: null,
			},
		});
		assert.equal(created.status, 201);
		const session = (await created.json()) as {
			uploadSessionId: string;
			mode: string;
			uploadId: string;
			partCount: number;
		};
		assert.equal(session.mode, 'multipart', 'file >100MB phải dùng multipart');
		harness.storage.putPart(session.uploadId, 1, partSize);
		harness.storage.putPart(session.uploadId, 2, 40 * 1024 * 1024);

		const response = await harness.request(`/uploads/${session.uploadSessionId}/complete`, {
			method: 'POST',
			body: {
				parts: [
					{ partNumber: 1, etag: 'etag-1', size: partSize },
					{ partNumber: 2, etag: 'etag-2', size: 40 * 1024 * 1024 },
				],
				uploadId: session.uploadId,
				checksumSha256: null,
			},
		});
		assert.equal(response.status, 201, `multipart hợp lệ phải 201, nhận ${response.status}`);
		const files = await harness.db.listFiles({ limit: 10, offset: 0 });
		assert.equal(files.length, 1);
		assert.equal(files[0]?.size, declared);
	});
});

describe('functional audit — abort upload dọn object mồ côi', () => {
	it('huỷ session single-part đã PUT ⇒ object bị xoá khỏi storage', async () => {
		const harness = await createHarness();
		const created = await harness.request('/uploads', {
			method: 'POST',
			body: {
				fileName: 'orphan.bin',
				contentType: 'application/octet-stream',
				totalSize: 4,
				checksumSha256: null,
				folderId: null,
			},
		});
		assert.equal(created.status, 201);
		const session = (await created.json()) as { uploadSessionId: string };
		const stored = await harness.db.getUploadSession(session.uploadSessionId);
		assert.ok(stored);
		// Client đã PUT nội dung lên storage rồi bấm huỷ.
		harness.storage.putObject(stored.objectKey, { size: 4, etag: 'etag' });
		assert.equal(harness.storage.objects.has(stored.objectKey), true);

		const response = await harness.request(`/uploads/${session.uploadSessionId}`, { method: 'DELETE' });
		assert.equal(response.status, 200, `huỷ upload phải 200, nhận ${response.status}`);
		assert.equal(
			harness.storage.objects.has(stored.objectKey),
			false,
			'object đã PUT nhưng session bị huỷ phải bị xoá (không để lại mồ côi)',
		);
	});
});
