import {
	AppError,
	addDays,
	fileListQuerySchema,
	fileMoveSchema,
	renameSchema,
	TRASH_RETENTION_DAYS,
} from '@alkcloud/core';
import { Hono } from 'hono';
import type { AppContext } from '../context.js';
import { recordAudit } from '../lib/audit.js';
import { decodeFileCursor, encodeFileCursor } from '../lib/cursor.js';
import { encodeRfc5987, json, mapDbConflict, parseJsonBody } from '../lib/http.js';
import { assertCapability, degradationHeaders } from '../lib/quota-guard.js';
import { requireOwner, type AppEnv } from '../middleware/auth.js';

export function createFilesRoutes(context: AppContext): Hono<AppEnv> {
	const app = new Hono<AppEnv>();
	app.use('*', requireOwner(context));

	app.get('/', async (c) => {
		const auth = c.get('auth');
		const mode = c.get('quotaMode');
		const parsed = fileListQuerySchema.safeParse(c.req.query());
		if (!parsed.success) throw AppError.badRequest('Query không hợp lệ');
		const query = parsed.data;
		if (query.q && query.q.length > 0) assertCapability(mode, 'allowSearch');

		// Phạm vi thư mục:
		// - có `q` (tìm kiếm) ⇒ xuyên suốt mọi thư mục;
		// - có `parentId` ⇒ đúng thư mục đó;
		// - `trashed=true` mà không có `parentId` ⇒ MỌI file trong thùng rác
		//   (trước đây mặc định `folder_id IS NULL` ⇒ file nằm trong thư mục
		//   bị xoá không bao giờ hiện trong thùng rác);
		// - còn lại ⇒ thư mục gốc.
		const folderScope: string | null | undefined = query.q
			? undefined
			: query.parentId !== undefined
				? query.parentId
				: query.trashed === 'true'
					? undefined
					: null;

		// Lấy `limit + 1` dòng để biết còn trang sau không (mà không cần
		// query COUNT(*) — tốn thêm 1 subrequest mỗi lần gọi).
		const rows = await context.db.listFiles({
			folderId: folderScope,
			query: query.q,
			limit: query.limit + 1,
			offset: 0,
			deletedOnly: query.trashed === 'true',
			cursor: query.cursor ? decodeFileCursor(query.cursor) : null,
		});
		const hasMore = rows.length > query.limit;
		const files = hasMore ? rows.slice(0, query.limit) : rows;
		const last = files[files.length - 1];
		return json(
			{
				files: files.map((file) => ({
					id: file.id,
					name: file.name,
					size: file.size,
					contentType: file.contentType,
					createdAt: file.createdAt,
					updatedAt: file.updatedAt,
					deletedAt: file.deletedAt,
					purgeAfter: file.purgeAfter,
					folderId: file.folderId,
				})),
				// Cursor cho trang kế tiếp (null = đã hết danh sách).
				nextCursor:
					hasMore && last ? encodeFileCursor({ nameLower: last.nameLower, id: last.id }) : null,
				mode,
			},
			200,
			degradationHeaders(mode),
		);
	});

	app.get('/trash', async (c) => {
		const files = await context.db.listTrashFiles(100);
		return json({
			files: files.map((file) => ({
				id: file.id,
				name: file.name,
				size: file.size,
				deletedAt: file.deletedAt,
				purgeAfter: file.purgeAfter,
			})),
			retentionDays: TRASH_RETENTION_DAYS,
		});
	});

	app.get('/:id', async (c) => {
		const file = await context.db.getFile(c.req.param('id'));
		if (!file) throw AppError.notFound('Không tìm thấy file');
		// SEC-08: file trong trash coi như "không còn" — giống hệt download/open.
		// Ngoài ra KHÔNG trả raw row (objectKey, etag, revisionId, nameLower...)
		// cho client: các field nội bộ không cần thiết cho UI.
		if (file.deletedAt) throw AppError.notFound('Không tìm thấy file');
		return json({
			file: {
				id: file.id,
				name: file.name,
				size: file.size,
				contentType: file.contentType,
				folderId: file.folderId,
				createdAt: file.createdAt,
				updatedAt: file.updatedAt,
				checksumSha256: file.checksumSha256,
			},
		});
	});

	app.patch('/:id', async (c) => {
		const auth = c.get('auth');
		const mode = c.get('quotaMode');
		const file = await context.db.getFile(c.req.param('id'));
		if (!file || file.deletedAt) throw AppError.notFound('Không tìm thấy file');
		const parsed = renameSchema.safeParse(await parseJsonBody<unknown>(c.req.raw).catch(() => ({})));
		if (!parsed.success) throw AppError.badRequest('Dữ liệu không hợp lệ');
		// Optimistic concurrency: client gửi `version` của lúc nó đọc danh sách.
		// Nếu file đã bị đổi/đổi tên/xoá bởi request khác ⇒ 409 thay vì ghi đè.
		if (parsed.data.version !== undefined && parsed.data.version !== file.version) {
			throw AppError.conflict('File đã thay đổi — tải lại danh sách rồi thử lại');
		}

		const now = context.now().toISOString();
		if (parsed.data.name !== file.name) {
			try {
				const renamed = await context.db.renameFile(
					file.id,
					parsed.data.name,
					now,
					parsed.data.version,
				);
				if (!renamed) {
					throw AppError.conflict('File đã thay đổi — tải lại danh sách rồi thử lại');
				}
			} catch (error) {
				mapDbConflict(error, `Đã có file tên "${parsed.data.name}" trong thư mục này`);
			}
			await recordAudit(context, {
				action: 'file.rename',
				actor: auth?.email ?? 'unknown',
				targetType: 'file',
				targetId: file.id,
				ip: c.get('clientIp'),
				metadata: { from: file.name, to: parsed.data.name },
			});
		}
		return json({ ok: true, mode }, 200, degradationHeaders(mode));
	});

	app.post('/:id/move', async (c) => {
		const auth = c.get('auth');
		const mode = c.get('quotaMode');
		const file = await context.db.getFile(c.req.param('id'));
		if (!file || file.deletedAt) throw AppError.notFound('Không tìm thấy file');
		// Schema BẮT BUỘC có `folderId` (null = về gốc): body rỗng hoặc sai key
		// ⇒ 400, không được lặng lẽ chuyển file về gốc.
		const parsed = fileMoveSchema.safeParse(await parseJsonBody<unknown>(c.req.raw).catch(() => ({})));
		if (!parsed.success) throw AppError.badRequest('Dữ liệu di chuyển không hợp lệ');
		if (parsed.data.version !== undefined && parsed.data.version !== file.version) {
			throw AppError.conflict('File đã thay đổi — tải lại danh sách rồi thử lại');
		}
		const folderId = parsed.data.folderId;
		if (folderId) {
			const folder = await context.db.getFolder(folderId);
			if (!folder || folder.deletedAt) throw AppError.notFound('Thư mục đích không tồn tại');
		}
		try {
			const moved = await context.db.moveFile(
				file.id,
				folderId,
				context.now().toISOString(),
				parsed.data.version,
			);
			if (!moved) {
				throw AppError.conflict('File đã thay đổi — tải lại danh sách rồi thử lại');
			}
		} catch (error) {
			mapDbConflict(error, `Thư mục đích đã có file tên "${file.name}"`);
		}
		await recordAudit(context, {
			action: 'file.move',
			actor: auth?.email ?? 'unknown',
			targetType: 'file',
			targetId: file.id,
			ip: c.get('clientIp'),
			metadata: { from: file.folderId, to: folderId },
		});
		return json({ ok: true, mode }, 200, degradationHeaders(mode));
	});

	app.delete('/:id', async (c) => {
		const auth = c.get('auth');
		const mode = c.get('quotaMode');
		const file = await context.db.getFile(c.req.param('id'));
		if (!file || file.deletedAt) throw AppError.notFound('Không tìm thấy file');
		// `version` tuỳ chọn: client có thể gửi để chống ghi đè thao tác.
		const body = (await parseJsonBody<{ version?: number }>(c.req.raw).catch(() => ({}))) as {
			version?: number;
		};
		if (body.version !== undefined && body.version !== file.version) {
			throw AppError.conflict('File đã thay đổi — tải lại danh sách rồi thử lại');
		}
		const now = context.now();
		const batchId = `bat_${crypto.randomUUID().replace(/-/g, '').slice(0, 20)}`;
		const deleted = await context.db.softDeleteFile(
			file.id,
			batchId,
			addDays(now.toISOString(), TRASH_RETENTION_DAYS),
			now.toISOString(),
			body.version,
		);
		if (!deleted) {
			throw AppError.conflict('File đã thay đổi — tải lại danh sách rồi thử lại');
		}
		await recordAudit(context, {
			action: 'file.delete',
			actor: auth?.email ?? 'unknown',
			targetType: 'file',
			targetId: file.id,
			ip: c.get('clientIp'),
			metadata: { batchId, retentionDays: TRASH_RETENTION_DAYS },
		});
		return json({ ok: true, purgeAfter: addDays(now.toISOString(), TRASH_RETENTION_DAYS), mode }, 200, degradationHeaders(mode));
	});

	app.post('/:id/restore', async (c) => {
		const auth = c.get('auth');
		const mode = c.get('quotaMode');
		const file = await context.db.getFile(c.req.param('id'));
		if (!file || !file.deletedAt) throw AppError.notFound('File không trong trash');
		// Đang xoá vĩnh viễn (object có thể đã bị xoá) ⇒ không khôi phục được.
		if (file.purgeState === 'PURGING') {
			throw AppError.conflict('File đang được xoá vĩnh viễn — không thể khôi phục');
		}
		// Thư mục chứa file còn trong trash ⇒ file vô hình sau khi restore.
		if (file.folderId) {
			const folder = await context.db.getFolder(file.folderId);
			if (folder?.deletedAt) {
				throw AppError.conflict('Thư mục chứa file đang trong trash — khôi phục thư mục trước');
			}
		}
		try {
			const restored = await context.db.restoreFile(file.id, context.now().toISOString());
			if (!restored) {
				throw AppError.conflict('File đang được xoá vĩnh viễn — không thể khôi phục');
			}
		} catch (error) {
			mapDbConflict(error, `Đã có file tên "${file.name}" trong thư mục này`);
		}
		await recordAudit(context, {
			action: 'file.restore',
			actor: auth?.email ?? 'unknown',
			targetType: 'file',
			targetId: file.id,
			ip: c.get('clientIp'),
		});
		return json({ ok: true, mode }, 200, degradationHeaders(mode));
	});

	app.delete('/:id/purge', async (c) => {
		const auth = c.get('auth');
		const mode = c.get('quotaMode');
		assertCapability(mode, 'allowTrashPurge');
		const file = await context.db.getFile(c.req.param('id'));
		if (!file || !file.deletedAt) throw AppError.notFound('File không trong trash');
		// Owner được xoá vĩnh viễn NGAY, không cần chờ hết retention 30 ngày.
		// `purge_after` chỉ là mốc để cron tự dọn — không phải điều kiện chặn.
		//
		// Share của file bị xoá vĩnh viễn ⇒ **tự thu hồi** (không chặn thao tác):
		// link cũ phải chết theo file thay vì để lại link "sống" mở ra 404.
		const revokedShares = await context.db.revokeActiveSharesForFiles(
			[file.id],
			context.now().toISOString(),
		);
		for (const shareId of revokedShares) {
			await recordAudit(context, {
				action: 'share.revoke',
				actor: auth?.email ?? 'unknown',
				targetType: 'share',
				targetId: shareId,
				ip: c.get('clientIp'),
				metadata: { reason: 'file_purge' },
			});
		}
		// SEC-09: tra cứu TRỰC TIẾP theo object_key thay vì quét 200 session cũ nhất
		// (nếu > 200 session OPEN, session liên quan nằm ngoài cửa sổ bị bỏ sót).
		const relatedUpload = await context.db.findOpenUploadSessionByObjectKey(file.objectKey);
		if (relatedUpload) {
			throw AppError.conflict('Còn upload session liên quan — abort upload trước');
		}

		// AUD-02: đánh dấu `PURGING` **TRƯỚC** khi xoá object ⇒ restore chạy đồng
		// thời bị từ chối (409) ⇒ không tạo được file "ma" (row còn, object đã mất).
		const started = await context.db.markFilePurgeStarted(file.id, context.now().toISOString(), true);
		if (!started) {
			throw AppError.conflict('File đang được xoá vĩnh viễn — không thao tác');
		}

		// Purge toàn bộ version của object ở B2 (nếu versioning bật).
		try {
			const versions = await context.storage.listObjectVersions(file.objectKey);
			for (const version of versions) {
				await context.storage.deleteObjectVersion(file.objectKey, version.versionId);
			}
			if (versions.length === 0) await context.storage.deleteObject(file.objectKey);
		} catch (error) {
			// Object còn nguyên ⇒ trả state về `NONE` để owner vẫn restore được
			// và lần cron sau thử xoá lại.
			await context.db.cancelFilePurge(file.id, context.now().toISOString());
			throw AppError.quota('Chưa xóa được object trên B2 — sẽ thử lại ở lần cron sau', 300);
		}
		// SEC-09: xoá có điều kiện — nếu file đã được restore (hoặc purge_after
		// bị đổi) trong lúc request này đang chạy thì KHÔNG được xoá.
		// Nếu xoá B2 xong mà D1 không xoá ⇒ mất file vĩnh viễn.
		const deleted = await context.db.deleteFileRowIfStillTrashed(file.id, context.now().toISOString(), true);
		if (!deleted) {
			throw AppError.conflict('File đã được khôi phục hoặc thay đổi — không xoá vĩnh viễn');
		}
		await recordAudit(context, {
			action: 'file.purge',
			actor: auth?.email ?? 'unknown',
			targetType: 'file',
			targetId: file.id,
			ip: c.get('clientIp'),
			metadata: { versionsPurged: true, revokedShares: revokedShares.length },
		});
		return json({ ok: true });
	});

	app.get('/:id/download', async (c) => {
		const mode = c.get('quotaMode');
		// Owner tải file của chính mình: luôn được phép, kể cả EMERGENCY.
		assertCapability(mode, 'allowOwnerDownload');
		const file = await context.db.getFile(c.req.param('id'));
		if (!file || file.deletedAt) throw AppError.notFound('Không tìm thấy file');

		// KHÔNG stream byte qua Worker: redirect (302) tới presigned GET của B2.
		// Worker chỉ ký URL (vài ms CPU) — trình duyệt tải trực tiếp từ B2.
		const target = await context.storage.presignGet({
			key: file.objectKey,
			expiresInSeconds: 300,
			responseContentType: file.contentType || 'application/octet-stream',
			responseContentDisposition: `attachment; filename*=UTF-8''${encodeRfc5987(file.name)}`,
		});
		return new Response(null, {
			status: 302,
			headers: { location: target.url, 'cache-control': 'private, no-store' },
		});
	});

	app.get('/:id/open', async (c) => {
		const mode = c.get('quotaMode');
		assertCapability(mode, 'allowOwnerDownload');
		const file = await context.db.getFile(c.req.param('id'));
		if (!file || file.deletedAt) throw AppError.notFound('Không tìm thấy file');
		const target = await context.storage.presignGet({ key: file.objectKey, expiresInSeconds: 300 });
		return json({
			url: target.url,
			expiresAt: target.expiresAt,
			contentType: file.contentType,
			name: file.name,
			size: file.size,
		});
	});

	return app;
}
