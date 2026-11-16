import { AppError, addDays, folderCreateSchema, moveSchema, renameSchema, TRASH_RETENTION_DAYS } from '@alkcloud/core';
import { Hono } from 'hono';
import type { AppContext } from '../context.js';
import { recordAudit } from '../lib/audit.js';
import { json, mapDbConflict, parseJsonBody } from '../lib/http.js';
import { assertCapability, degradationHeaders } from '../lib/quota-guard.js';
import { requireOwner, type AppEnv } from '../middleware/auth.js';

const MAX_FOLDER_DEPTH = 32;

export function createFoldersRoutes(context: AppContext): Hono<AppEnv> {
	const app = new Hono<AppEnv>();
	app.use('*', requireOwner(context));

	app.get('/', async (c) => {
		const parentId = c.req.query('parentId') ?? null;
		const folders = await context.db.listFolders(parentId);
		return json({
			folders: folders.map((folder) => ({
				id: folder.id,
				name: folder.name,
				parentId: folder.parentId,
				depth: folder.depth,
				createdAt: folder.createdAt,
			})),
		});
	});

	// Cây thư mục phẳng (id, name, parentId, depth) — 1 request cho bộ chọn
	// thư mục kiểu Windows trong hộp thoại "Di chuyển".
	app.get('/tree', async (c) => {
		const folders = await context.db.listAllFolders(1000);
		return json({
			folders: folders.map((folder) => ({
				id: folder.id,
				name: folder.name,
				parentId: folder.parentId,
				depth: folder.depth,
				createdAt: folder.createdAt,
			})),
		});
	});

	app.get('/trash', async (c) => {
		const folders = await context.db.listTrashFolders(100);
		return json({
			folders: folders.map((folder) => ({
				id: folder.id,
				name: folder.name,
				parentId: folder.parentId,
				deletedAt: folder.deletedAt,
			})),
			retentionDays: TRASH_RETENTION_DAYS,
		});
	});

	app.post('/', async (c) => {
		const auth = c.get('auth');
		const mode = c.get('quotaMode');
		const parsed = folderCreateSchema.safeParse(await parseJsonBody<unknown>(c.req.raw).catch(() => ({})));
		if (!parsed.success) throw AppError.badRequest('Dữ liệu thư mục không hợp lệ');

		let depth = 0;
		if (parsed.data.parentId) {
			const parent = await context.db.getFolder(parsed.data.parentId);
			if (!parent || parent.deletedAt) throw AppError.notFound('Thư mục cha không tồn tại');
			depth = parent.depth + 1;
			if (depth > MAX_FOLDER_DEPTH) throw AppError.badRequest('Độ sâu thư mục vượt giới hạn');
		}

		const now = context.now().toISOString();
		let folder;
		try {
			folder = await context.db.createFolder({
				id: `fld_${crypto.randomUUID().replace(/-/g, '').slice(0, 24)}`,
				parentId: parsed.data.parentId ?? null,
				name: parsed.data.name,
				depth,
				now,
			});
		} catch (error) {
			mapDbConflict(error, `Đã có thư mục tên "${parsed.data.name}" tại vị trí này`);
		}
		await recordAudit(context, {
			action: 'folder.create',
			actor: auth?.email ?? 'unknown',
			targetType: 'folder',
			targetId: folder.id,
			ip: c.get('clientIp'),
			metadata: { name: folder.name, parentId: folder.parentId },
		});
		return json({ folder }, 201, degradationHeaders(mode));
	});

	app.patch('/:id', async (c) => {
		const auth = c.get('auth');
		const mode = c.get('quotaMode');
		const folder = await context.db.getFolder(c.req.param('id'));
		if (!folder || folder.deletedAt) throw AppError.notFound('Không tìm thấy thư mục');
		const parsed = renameSchema.safeParse(await parseJsonBody<unknown>(c.req.raw).catch(() => ({})));
		if (!parsed.success) throw AppError.badRequest('Dữ liệu không hợp lệ');
		// Optimistic concurrency (xem `POST /files/:id/move`).
		if (parsed.data.version !== undefined && parsed.data.version !== folder.version) {
			throw AppError.conflict('Thư mục đã thay đổi — tải lại danh sách rồi thử lại');
		}
		try {
			const renamed = await context.db.renameFolder(
				folder.id,
				parsed.data.name,
				context.now().toISOString(),
				parsed.data.version,
			);
			if (!renamed) {
				throw AppError.conflict('Thư mục đã thay đổi — tải lại danh sách rồi thử lại');
			}
		} catch (error) {
			mapDbConflict(error, `Đã có thư mục tên "${parsed.data.name}" tại vị trí này`);
		}
		await recordAudit(context, {
			action: 'folder.rename',
			actor: auth?.email ?? 'unknown',
			targetType: 'folder',
			targetId: folder.id,
			ip: c.get('clientIp'),
			metadata: { from: folder.name, to: parsed.data.name },
		});
		return json({ ok: true, mode }, 200, degradationHeaders(mode));
	});

	app.post('/:id/move', async (c) => {
		const auth = c.get('auth');
		const mode = c.get('quotaMode');
		const folder = await context.db.getFolder(c.req.param('id'));
		if (!folder || folder.deletedAt) throw AppError.notFound('Không tìm thấy thư mục');
		const parsed = moveSchema.safeParse(await parseJsonBody<unknown>(c.req.raw).catch(() => ({})));
		if (!parsed.success) throw AppError.badRequest('Dữ liệu không hợp lệ');
		if (parsed.data.version !== undefined && parsed.data.version !== folder.version) {
			throw AppError.conflict('Thư mục đã thay đổi — tải lại danh sách rồi thử lại');
		}

		let depth = 0;
		if (parsed.data.parentId) {
			if (parsed.data.parentId === folder.id) throw AppError.badRequest('Không thể di chuyển vào chính nó');
			const parent = await context.db.getFolder(parsed.data.parentId);
			if (!parent || parent.deletedAt) throw AppError.notFound('Thư mục đích không tồn tại');
			// CHỈ tính thư mục còn active: con đã xoá (trash) không làm tăng độ sâu.
			// Trước đây tính cả cây trash ⇒ thư mục có con đã xoá bị từ chối move
			// ("Độ sâu thư mục vượt giới hạn") dù cây active rất nông.
			const subtree = await context.db.listFolderSubtree(folder.id, { includeDeleted: false });
			if (subtree.some((node) => node.id === parent.id)) {
				throw AppError.badRequest('Không thể di chuyển thư mục vào chính subtree của nó');
			}
			depth = parent.depth + 1;
			if (depth + (subtree.length ? Math.max(...subtree.map((node) => node.depth)) - folder.depth : 0) > MAX_FOLDER_DEPTH) {
				throw AppError.badRequest('Độ sâu thư mục vượt giới hạn');
			}
		}
		try {
			const moved = await context.db.moveFolder(
				folder.id,
				parsed.data.parentId ?? null,
				depth,
				context.now().toISOString(),
				parsed.data.version,
			);
			if (!moved) {
				throw AppError.conflict('Thư mục đã thay đổi — tải lại danh sách rồi thử lại');
			}
		} catch (error) {
			mapDbConflict(error, `Thư mục đích đã có thư mục tên "${folder.name}"`);
		}
		await recordAudit(context, {
			action: 'folder.move',
			actor: auth?.email ?? 'unknown',
			targetType: 'folder',
			targetId: folder.id,
			ip: c.get('clientIp'),
			metadata: { from: folder.parentId, to: parsed.data.parentId ?? null },
		});
		return json({ ok: true, mode }, 200, degradationHeaders(mode));
	});

	app.delete('/:id', async (c) => {
		const auth = c.get('auth');
		const mode = c.get('quotaMode');
		const folder = await context.db.getFolder(c.req.param('id'));
		if (!folder || folder.deletedAt) throw AppError.notFound('Không tìm thấy thư mục');
		// `version` tuỳ chọn: client có thể gửi để chống ghi đè thao tác.
		const body = (await parseJsonBody<{ version?: number }>(c.req.raw).catch(() => ({}))) as {
			version?: number;
		};
		if (body.version !== undefined && body.version !== folder.version) {
			throw AppError.conflict('Thư mục đã thay đổi — tải lại danh sách rồi thử lại');
		}
		const batchId = `bat_${crypto.randomUUID().replace(/-/g, '').slice(0, 20)}`;
		const now = context.now().toISOString();
		// Cần cả cây trash: file nằm trong thư mục con đã xoá trước đó cũng phải
		// được gom vào batch xoá (nếu không, chúng không bao giờ được purge).
		const subtree = await context.db.listFolderSubtree(folder.id);
		// SEC-05: 1 câu UPDATE (recursive CTE) cho toàn bộ subtree, KHÔNG loop từng node.
		// Loop từng node = 1 subrequest mỗi node ⇒ vượt trần 50 subrequest của
		// Workers Free ⇒ request chết giữa chừng ⇒ file mồ côi vĩnh viễn.
		const nodesDeleted = await context.db.softDeleteFolderSubtree(
			folder.id,
			batchId,
			now,
			body.version,
		);
		if (nodesDeleted === 0) {
			throw AppError.conflict('Thư mục đã thay đổi — tải lại danh sách rồi thử lại');
		}
		// File bên trong thư mục cũng phải vào trash cùng batch — nếu không, chúng
		// thành mồ côi: vẫn tính quota, không hiện trong trash, không bao giờ purge.
		const purgeAfter = addDays(now, TRASH_RETENTION_DAYS);
		const filesDeleted = await context.db.softDeleteFilesInFolders(
			subtree.map((node) => node.id),
			batchId,
			purgeAfter,
			now,
		);
		await recordAudit(context, {
			action: 'folder.delete',
			actor: auth?.email ?? 'unknown',
			targetType: 'folder',
			targetId: folder.id,
			ip: c.get('clientIp'),
			metadata: { batchId, nodes: nodesDeleted, files: filesDeleted },
		});
		return json(
			{ ok: true, deleted: nodesDeleted, files: filesDeleted, mode },
			200,
			degradationHeaders(mode),
		);
	});

	app.post('/:id/restore', async (c) => {
		const auth = c.get('auth');
		const mode = c.get('quotaMode');
		const folder = await context.db.getFolder(c.req.param('id'));
		if (!folder || !folder.deletedAt) throw AppError.notFound('Thư mục không trong trash');
		// Thư mục cha còn trong trash ⇒ file/thư mục con vẫn vô hình sau khi restore.
		if (folder.parentId) {
			const parent = await context.db.getFolder(folder.parentId);
			if (parent?.deletedAt) {
				throw AppError.conflict('Thư mục cha đang trong trash — khôi phục thư mục cha trước');
			}
		}
		const now = context.now().toISOString();
		// PHẢI gồm cả cây trash: thư mục đang xoá ⇒ toàn bộ hậu duệ cũng đang xoá,
		// và file cần restore nằm trong đó.
		const subtree = await context.db.listFolderSubtree(folder.id);
		// SEC-05: 1 câu UPDATE (recursive CTE) cho toàn bộ subtree.
		await context.db.restoreFolderSubtree(folder.id, now);
		// Khôi phục file trong cùng batch — CHỈ trong phạm vi subtree vừa khôi phục.
		// Nếu khôi phục cả batch thì file của thư mục anh em (folder cha vẫn còn
		// trong trash) sẽ bị "khôi phục" trong khi vẫn không truy cập được.
		const batchId = folder.deletedBatchId;
		const filesRestored = batchId
			? await context.db.restoreFilesByBatch(batchId, now, subtree.map((node) => node.id))
			: 0;
		await recordAudit(context, {
			action: 'folder.restore',
			actor: auth?.email ?? 'unknown',
			targetType: 'folder',
			targetId: folder.id,
			ip: c.get('clientIp'),
			metadata: { restored: subtree.length, files: filesRestored },
		});
		return json(
			{ ok: true, restored: subtree.length, files: filesRestored, mode },
			200,
			degradationHeaders(mode),
		);
	});

	app.delete('/:id/purge', async (c) => {
		const auth = c.get('auth');
		const mode = c.get('quotaMode');
		assertCapability(mode, 'allowTrashPurge');
		const folder = await context.db.getFolder(c.req.param('id'));
		if (!folder || !folder.deletedAt) throw AppError.notFound('Thư mục không trong trash');
		// Chỉ xoá vĩnh viễn khi cây con không còn file (đã purge từng file hoặc
		// file đã bị xoá vĩnh viễn trước đó). Xoá cascade folder khi còn file sẽ
		// khiến file mồ côi ở trash gốc — không bao giờ được purge.
		const filesInSubtree = await context.db.countFilesInFolderSubtree(folder.id);
		if (filesInSubtree > 0) {
			throw AppError.conflict(`Còn ${filesInSubtree} tệp trong thư mục — xoá vĩnh viễn các tệp trước`);
		}

		// Thu hồi share của thư mục + cây con trước khi xoá ⇒ link chia sẻ thư mục
		// không sống sót (nếu không, share vẫn còn và cây thư mục vẫn xem được).
		const now = context.now().toISOString();
		const subtreeFolders = new Set(await context.db.listFolderIdsInSubtree(folder.id));
		subtreeFolders.add(folder.id);
		const revokedShares = await context.db.revokeActiveSharesForFolders([...subtreeFolders], now);
		for (const shareId of revokedShares) {
			await recordAudit(context, {
				action: 'share.revoke',
				actor: auth?.email ?? 'unknown',
				targetType: 'share',
				targetId: shareId,
				ip: c.get('clientIp'),
				metadata: { reason: 'folder_purge', folderId: folder.id },
			});
		}

		const deleted = await context.db.deleteTrashedFolder(folder.id);
		if (!deleted) {
			throw AppError.conflict('Thư mục chưa thể xoá — còn tệp hoặc đã thay đổi');
		}
		await recordAudit(context, {
			action: 'folder.purge',
			actor: auth?.email ?? 'unknown',
			targetType: 'folder',
			targetId: folder.id,
			ip: c.get('clientIp'),
			metadata: { revokedShares: revokedShares.length },
		});
		return json({ ok: true, mode, revokedShares: revokedShares.length }, 200, degradationHeaders(mode));
	});

	return app;
}
