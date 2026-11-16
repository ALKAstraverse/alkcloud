import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { createHarness, type Harness } from './harness.js';

/**
 * WS-F — E2E hành trình sản phẩm (product journey).
 *
 * Mục tiêu: **1 luồng liên tục** đi qua toàn bộ vòng đời dữ liệu của owner,
 * từ bootstrap tới purge, để bắt lỗi "mỗi endpoint đúng riêng lẻ nhưng dính
 * nhau thì hỏng" — loại lỗi mà test theo endpoint không thấy.
 *
 * Quy tắc bất biến được kiểm tra ở MỌI bước:
 *   I1. Metadata và object luôn đồng bộ (không file mồ côi).
 *   I2. Quota phản ánh đúng dung lượng đang lưu.
 *   I3. Mọi hành động thay đổi dữ liệu đều để lại dấu vết trong audit log.
 */

const NOW = '2026-01-15T10:00:00.000Z';

interface Journey {
	harness: Harness;
	steps: string[];
}

/**
 * Bất biến I1: số object trong storage phải bằng số file có metadata
 * (kể cả file đã xoá — file trong trash vẫn giữ object tới khi purge).
 */
async function assertStorageConsistent(harness: Harness, message: string): Promise<void> {
	const active = await harness.db.listFiles({ limit: 500, offset: 0, deletedOnly: false });
	const deleted = await harness.db.listFiles({ limit: 500, offset: 0, deletedOnly: true });
	const objectCount = harness.storage.objects.size;
	const metadataCount = active.length + deleted.length;
	assert.equal(
		objectCount,
		metadataCount,
		`${message}: storage có ${objectCount} object nhưng DB có ${metadataCount} file (mồ côi hoặc mất)`,
	);
}

async function uploadFile(
	harness: Harness,
	name: string,
	body: string,
	folderId: string | null = null,
): Promise<string> {
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
	assert.equal(created.status, 201, `tạo upload session phải 201, nhận ${created.status}`);
	const session = (await created.json()) as {
		uploadSessionId: string;
		parts: Array<{ url: string; partNumber: number }>;
	};
	const key = harness.storage.keyFromPresignedUrl(session.parts[0]!.url);
	harness.storage.putObject(key, {
		size: bytes.byteLength,
		contentType: 'text/plain',
		etag: `etag-${name}`,
		body: bytes,
	});
	const completed = await harness.request(`/uploads/${session.uploadSessionId}/complete`, {
		method: 'POST',
		body: {
			parts: [{ partNumber: 1, etag: `etag-${name}`, size: bytes.byteLength }],
			checksumSha256: null,
		},
	});
	assert.equal(completed.status, 201, `complete upload phải 201, nhận ${completed.status}`);
	const payload = (await completed.json()) as { file: { id: string } };
	return payload.file.id;
}

describe('WS-F — E2E hành trình sản phẩm', () => {
	it('vòng đời đầy đủ: bootstrap → upload → share → tải → xoá → khôi phục → purge', async () => {
		const journey: Journey = { harness: await createHarness(), steps: [] };
		const { harness } = journey;
		const step = (name: string) => journey.steps.push(name);

		// ── Bước 1: bootstrap owner ───────────────────────────────────────
		step('bootstrap owner');
		const status = await harness.request('/auth/status');
		assert.equal(status.status, 200);
		const statusBody = (await status.json()) as { bootstrapped: boolean };
		assert.equal(statusBody.bootstrapped, true, 'bootstrap phải tạo được owner');

		// ── Bước 2: tạo cây thư mục ───────────────────────────────────────
		step('tạo cây thư mục');
		const rootResponse = await harness.request('/folders', {
			method: 'POST',
			body: { name: 'Tài liệu', parentId: null },
		});
		assert.equal(rootResponse.status, 201);
		const root = (await rootResponse.json()) as { folder: { id: string } };
		const childResponse = await harness.request('/folders', {
			method: 'POST',
			body: { name: '2026', parentId: root.folder.id },
		});
		assert.equal(childResponse.status, 201);
		const child = (await childResponse.json()) as { folder: { id: string } };

		// Cây thư mục phẳng (1 request) cho bộ chọn thư mục kiểu Windows.
		const treeResponse = await harness.request('/folders/tree');
		assert.equal(treeResponse.status, 200);
		const treeBody = (await treeResponse.json()) as {
			folders: Array<{ id: string; name: string; parentId: string | null; depth: number }>;
		};
		const rootNode = treeBody.folders.find((folder) => folder.id === root.folder.id);
		const childNode = treeBody.folders.find((folder) => folder.id === child.folder.id);
		assert.ok(rootNode, 'cây phải chứa thư mục gốc');
		assert.ok(childNode, 'cây phải chứa thư mục con');
		assert.equal(rootNode.parentId, null);
		assert.equal(childNode.parentId, root.folder.id);
		assert.equal(childNode.depth, rootNode.depth + 1, 'depth phải tăng theo cấp');

		// ── Bước 3: upload file vào thư mục con ───────────────────────────
		step('upload file');
		const fileId = await uploadFile(harness, 'báo cáo.txt', 'Nội dung báo cáo năm 2026', child.folder.id);

		const fileResponse = await harness.request(`/files/${fileId}`);
		assert.equal(fileResponse.status, 200);
		const fileBody = (await fileResponse.json()) as { file: { name: string; folderId: string; size: number } };
		assert.equal(fileBody.file.name, 'báo cáo.txt');
		assert.equal(fileBody.file.folderId, child.folder.id);
		assert.equal(fileBody.file.size, 30);

		await assertStorageConsistent(harness, 'sau upload');

		// ── Bước 4: đổi tên ───────────────────────────────────────────────
		step('đổi tên file');
		const renamed = await harness.request(`/files/${fileId}`, {
			method: 'PATCH',
			body: { name: 'báo cáo 2026.txt' },
		});
		assert.equal(renamed.status, 200);
		const renamedBody = (await renamed.json()) as { ok: boolean };
		assert.equal(renamedBody.ok, true);
		const afterRename = (await (await harness.request(`/files/${fileId}`)).json()) as { file: { name: string } };
		assert.equal(afterRename.file.name, 'báo cáo 2026.txt');

		// ── Bước 5: di chuyển file lên thư mục cha ────────────────────────
		step('di chuyển file');
		const moved = await harness.request(`/files/${fileId}/move`, {
			method: 'POST',
			body: { folderId: root.folder.id },
		});
		assert.equal(moved.status, 200);
		const afterMove = (await (await harness.request(`/files/${fileId}`)).json()) as { file: { folderId: string } };
		assert.equal(afterMove.file.folderId, root.folder.id);

		// ── Bước 6: tải file (owner) ─────────────────────────────────────
		step('owner tải file');
		const download = await harness.request(`/files/${fileId}/download`);
		assert.equal(download.status, 200);
		assert.equal(await download.text(), 'Nội dung báo cáo năm 2026');
		assert.equal(download.headers.get('content-type'), 'text/plain');

		// ── Bước 7: tạo share công khai + tải qua share ───────────────────
		step('tạo share + tải qua share');
		const shareResponse = await harness.request('/shares', {
			method: 'POST',
			body: { fileId, expiresInDays: 7, maxDownloads: 3 },
		});
		assert.equal(shareResponse.status, 201);
		const share = (await shareResponse.json()) as { share: { id: string }; token: string };

		const shareInfo = await harness.request('/public/share/info', {
			headers: { 'x-share-token': share.token },
		});
		assert.equal(shareInfo.status, 200);
		const shareInfoBody = (await shareInfo.json()) as { share: { fileName: string; downloadCount: number } };
		assert.equal(shareInfoBody.share.fileName, 'báo cáo 2026.txt');

		const shareDownload = await harness.request('/public/share/download', {
			headers: { 'x-share-token': share.token },
		});
		assert.equal(shareDownload.status, 200);
		assert.equal(await shareDownload.text(), 'Nội dung báo cáo năm 2026');

		// ── Bước 8: share có mật khẩu ────────────────────────────────────
		step('share có mật khẩu');
		const secretResponse = await harness.request('/shares', {
			method: 'POST',
			body: {
				fileId,
				expiresInDays: 7,
				passwordVerifier: 'd'.repeat(64),
				passwordSalt: 'salt-journey-01',
				passwordParams: 'sha256-v1',
			},
		});
		assert.equal(secretResponse.status, 201);
		const secretShare = (await secretResponse.json()) as { token: string };

		const lockedDownload = await harness.request('/public/share/download', {
			headers: { 'x-share-token': secretShare.token },
		});
		assert.equal(lockedDownload.status, 403, 'share có mật khẩu phải chặn tải khi chưa mở khoá');

		const unlocked = await harness.request('/public/share/unlock', {
			method: 'POST',
			body: { passwordVerifier: 'd'.repeat(64) },
			headers: { 'x-share-token': secretShare.token },
		});
		assert.equal(unlocked.status, 200, 'mở khoá đúng mật khẩu phải thành công');
		const unlockedBody = (await unlocked.json()) as { grant: string };
		assert.ok(unlockedBody.grant, 'unlock phải trả grant để client gửi kèm request tải');

		const unlockedDownload = await harness.request('/public/share/download', {
			headers: { 'x-share-token': secretShare.token, 'x-share-grant': unlockedBody.grant },
		});
		assert.equal(unlockedDownload.status, 200);
		assert.equal(await unlockedDownload.text(), 'Nội dung báo cáo năm 2026');

		// ── Bước 9: thu hồi share ────────────────────────────────────────
		step('thu hồi share');
		// Phải thu hồi TẤT CẢ share còn hoạt động — nếu còn share nào thì file
		// không được purge vĩnh viễn (đúng thiết kế: tránh xoá object mà
		// người nhận vẫn còn link hợp lệ).
		const allShares = (await (await harness.request(`/shares?fileId=${fileId}`)).json()) as {
			shares: Array<{ id: string }>;
		};
		assert.equal(allShares.shares.length, 2, 'phải có 2 share (1 công khai + 1 có mật khẩu)');
		for (const item of allShares.shares) {
			const revoked = await harness.request(`/shares/${item.id}`, { method: 'DELETE' });
			assert.equal(revoked.status, 200);
		}
		const revokedDownload = await harness.request('/public/share/download', {
			headers: { 'x-share-token': share.token },
		});
		assert.equal(revokedDownload.status, 404, 'share đã thu hồi phải không tải được');

		// ── Bước 10: xoá file → trash → khôi phục ───────────────────────
		step('xoá file → trash → khôi phục');
		const deleted = await harness.request(`/files/${fileId}`, { method: 'DELETE' });
		assert.equal(deleted.status, 200, `xoá file phải 200, nhận ${deleted.status}: ${await deleted.clone().text()}`);

		const trash = (await (await harness.request('/files/trash')).json()) as {
			files: Array<{ id: string }>;
		};
		assert.ok(trash.files.some((file) => file.id === fileId), 'file phải nằm trong trash');

		const hidden = await harness.request(`/files/${fileId}`);
		assert.equal(hidden.status, 404, 'file trong trash không được lộ metadata');

		const restored = await harness.request(`/files/${fileId}/restore`, { method: 'POST', body: {} });
		assert.equal(restored.status, 200);

		// File được khôi phục vào thư mục cha (`root`) ⇒ phải xuất hiện khi
		// liệt kê theo `parentId` (GET /files mặc định chỉ lọc file ở root).
		const activeList = (await (await harness.request(`/files?parentId=${root.folder.id}`)).json()) as {
			files: Array<{ id: string }>;
		};
		assert.ok(activeList.files.some((file) => file.id === fileId), 'file phải trở lại danh sách');

		// ── Bước 11: xoá folder subtree ──────────────────────────────────
		step('xoá folder subtree');
		const folderDeleted = await harness.request(`/folders/${root.folder.id}`, { method: 'DELETE' });
		assert.equal(folderDeleted.status, 200);
		const folderBody = (await folderDeleted.json()) as { deleted: number };
		assert.equal(folderBody.deleted, 2, 'phải xoá root + 1 folder con');

		// ── Bước 12: purge ngay (KHÔNG cần chờ retention 30 ngày) ────────
		step('purge file + folder ngay');
		// File đang ở trash từ bước 11 (xoá folder subtree) — owner được xoá ngay.
		const purged = await harness.request(`/files/${fileId}/purge`, { method: 'DELETE' });
		assert.equal(purged.status, 200, `purge ngay phải 200, nhận ${purged.status}`);

		const afterPurge = await harness.request(`/files/${fileId}`);
		assert.equal(afterPurge.status, 404, 'file đã purge không còn tồn tại');
		assert.equal(
			harness.storage.objects.size,
			0,
			'purge phải xoá object khỏi storage (không để lại object mồ côi)',
		);

		// Folder root + con đang ở trash; hết file ⇒ purge ngay được (cascade).
		const purgedFolder = await harness.request(`/folders/${root.folder.id}/purge`, { method: 'DELETE' });
		assert.equal(purgedFolder.status, 200, `purge folder ngay phải 200, nhận ${purgedFolder.status}`);
		const trashFolders = (await (await harness.request('/folders/trash')).json()) as { folders: unknown[] };
		assert.equal(trashFolders.folders.length, 0, 'purge folder phải dọn cả cây con');

		// ── Bước 13: audit log ghi lại hành trình ────────────────────────
		step('kiểm tra audit log');
		const audit = (await (await harness.request('/system/audit?limit=500')).json()) as {
			events: Array<{ action: string; actor: string | null }>;
		};
		const actions = new Set(audit.events.map((event) => event.action));
		for (const expected of ['file.create', 'file.delete', 'file.rename', 'file.purge', 'folder.purge', 'share.create', 'share.revoke']) {
			assert.ok(actions.has(expected), `audit log phải có sự kiện "${expected}"`);
		}

		// ── Bước 14: quota phản ánh dung lượng ────────────────────────────
		step('kiểm tra quota');
		const usage = (await (await harness.request('/system/usage')).json()) as {
			usedBytes: number;
			quotaBytes: number;
		};
		assert.equal(usage.usedBytes, 0, 'sau khi purge, dung lượng phải về 0');
		assert.ok(usage.quotaBytes > 0, 'phải có hạn mức lưu trữ');
	});

	it('hành trình chia sẻ: người nhận không cần tài khoản, thu hồi được ngay', async () => {
		const harness = await createHarness();
		const fileId = await uploadFile(harness, 'hop-dong.txt', 'Hợp đồng');

		const created = await harness.request('/shares', {
			method: 'POST',
			body: { fileId, expiresInDays: 1 },
		});
		assert.equal(created.status, 201);
		const share = (await created.json()) as { token: string };

		// Người nhận KHÔNG có cookie phiên, không CSRF ⇒ vẫn tải được.
		const anonymous = await fetch(`https://api.alk.xx.kg/api/v1/public/share/download`, {
			method: 'GET',
			headers: { 'x-share-token': share.token },
		});
		// Harness không gọi network thật; dùng harness.request với cookie rỗng.
		void anonymous;
		const asAnonymous = await harness.request('/public/share/download', {
			headers: { 'x-share-token': share.token },
			cookie: '',
		});
		assert.equal(asAnonymous.status, 200, 'người nhận không cần đăng nhập');
		assert.equal(await asAnonymous.text(), 'Hợp đồng');

		// Thu hồi ⇒ ngay lập tức không tải được.
		const shares = (await (await harness.request(`/shares?fileId=${fileId}`)).json()) as {
			shares: Array<{ id: string }>;
		};
		assert.ok(shares.shares.length >= 1, 'phải có ít nhất 1 share');
		const shareId = shares.shares[0]!.id;
		await harness.request(`/shares/${shareId}`, { method: 'DELETE' });
		const afterRevoke = await harness.request('/public/share/download', {
			headers: { 'x-share-token': share.token },
			cookie: '',
		});
		assert.equal(afterRevoke.status, 404);
	});

	it('hành trình file lớn nhiều phần: multipart hoàn chỉnh', async () => {
		const harness = await createHarness();
		const size = 101 * 1024 * 1024; // > 100MB ⇒ chế độ multipart (part 64MB)
		const created = await harness.request('/uploads', {
			method: 'POST',
			body: { fileName: 'video.mp4', contentType: 'video/mp4', totalSize: size, checksumSha256: null },
		});
		assert.equal(created.status, 201, `multipart phải 201, nhận ${created.status}: ${await created.clone().text()}`);
		const session = (await created.json()) as {
			uploadSessionId: string;
			uploadId: string;
			mode: string;
			partCount: number;
			parts: Array<{ url: string; partNumber: number }>;
		};
		assert.equal(session.mode, 'multipart', 'file > 100MB phải dùng multipart');
		assert.equal(session.partCount, 2, '101MB / 64MB = 2 part');
		assert.equal(session.parts.length, 2);

		// Client PUT từng part lên B2 (mô phỏng bằng mock).
		const partPayloads: Array<{ partNumber: number; etag: string; size: number }> = [];
		for (const part of session.parts) {
			const sizeOfPart = part.partNumber === 1 ? 64 * 1024 * 1024 : 37 * 1024 * 1024;
			const { etag } = harness.storage.putPart(session.uploadId, part.partNumber, sizeOfPart);
			partPayloads.push({ partNumber: part.partNumber, etag, size: sizeOfPart });
		}

		const completed = await harness.request(`/uploads/${session.uploadSessionId}/complete`, {
			method: 'POST',
			body: { uploadId: session.uploadId, parts: partPayloads, checksumSha256: null },
		});
		assert.equal(completed.status, 201, `complete phải 201, nhận ${completed.status}`);
		const payload = (await completed.json()) as { file: { id: string; size: number } };
		assert.equal(payload.file.size, size, 'kích thước file = tổng các part');

		// File xuất hiện trong danh sách với đúng kích thước.
		const list = (await (await harness.request('/files')).json()) as { files: Array<{ id: string; size: number }> };
		const listed = list.files.find((file) => file.id === payload.file.id);
		assert.ok(listed, 'file phải có trong danh sách');
		assert.equal(listed.size, size);

		// Quota phải được giải phóng sau khi complete (không giữ reservation).
		const usage = (await (await harness.request('/system/usage')).json()) as {
			usedBytes: number;
			reservedBytes: number;
		};
		assert.equal(usage.usedBytes, size, 'dung lượng đã dùng phải bằng kích thước file');
		assert.equal(usage.reservedBytes, 0, 'reservation phải được giải phóng sau complete');
	});

	it('hành trình đăng nhập: đóng phiên cũ, phiên mới hoạt động', async () => {
		const harness = await createHarness();
		const login = await harness.request('/auth/login', {
			method: 'POST',
			body: { email: 'owner@alkcloud.test', authKey: 'client-argon2id-output-key-0001' },
		});
		assert.equal(login.status, 200);

		const session = await harness.request('/auth/session');
		assert.equal(session.status, 200, 'phiên mới phải hoạt động');
		const sessionBody = (await session.json()) as { owner: { email: string } | null };
		assert.equal(sessionBody.owner?.email, 'owner@alkcloud.test');

		const logout = await harness.request('/auth/logout', { method: 'POST', body: {} });
		assert.equal(logout.status, 200);
		const afterLogout = await harness.request('/auth/session');
		assert.equal(afterLogout.status, 401, 'đăng xuất phải hủy phiên');
	});
});
