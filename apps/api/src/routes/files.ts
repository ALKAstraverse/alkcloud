import { AppError, addDays, fileListQuerySchema, renameSchema, TRASH_RETENTION_DAYS } from '@alkcloud/core';
import { Hono } from 'hono';
import type { AppContext } from '../context.js';
import { recordAudit } from '../lib/audit.js';
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

		const files = await context.db.listFiles({
			folderId: query.q ? undefined : (query.parentId ?? null),
			query: query.q,
			limit: query.limit,
			offset: 0,
			includeDeleted: query.trashed === 'true',
		});
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
		return json({ file });
	});

	app.patch('/:id', async (c) => {
		const auth = c.get('auth');
		const mode = c.get('quotaMode');
		const file = await context.db.getFile(c.req.param('id'));
		if (!file || file.deletedAt) throw AppError.notFound('Không tìm thấy file');
		const parsed = renameSchema.safeParse(await parseJsonBody<unknown>(c.req.raw).catch(() => ({})));
		if (!parsed.success) throw AppError.badRequest('Dữ liệu không hợp lệ');

		const now = context.now().toISOString();
		if (parsed.data.name !== file.name) {
			try {
				await context.db.renameFile(file.id, parsed.data.name, now);
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
		const body = (await parseJsonBody<{ folderId?: string | null }>(c.req.raw).catch(() => ({}))) as {
			folderId?: string | null;
		};
		const folderId = body.folderId ?? null;
		if (folderId) {
			const folder = await context.db.getFolder(folderId);
			if (!folder || folder.deletedAt) throw AppError.notFound('Thư mục đích không tồn tại');
		}
		try {
			await context.db.moveFile(file.id, folderId, context.now().toISOString());
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
		const now = context.now();
		const batchId = `bat_${crypto.randomUUID().replace(/-/g, '').slice(0, 20)}`;
		await context.db.softDeleteFile(file.id, batchId, addDays(now.toISOString(), TRASH_RETENTION_DAYS), now.toISOString());
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
		// Thư mục chứa file còn trong trash ⇒ file vô hình sau khi restore.
		if (file.folderId) {
			const folder = await context.db.getFolder(file.folderId);
			if (folder?.deletedAt) {
				throw AppError.conflict('Thư mục chứa file đang trong trash — khôi phục thư mục trước');
			}
		}
		try {
			await context.db.restoreFile(file.id, context.now().toISOString());
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
		if (!file.purgeAfter || new Date(file.purgeAfter).getTime() > context.now().getTime()) {
			throw AppError.conflict('Chưa tới hạn xóa vĩnh viễn');
		}
		const activeShares = await context.db.countActiveShares(file.id, context.now().toISOString());
		if (activeShares > 0) {
			throw AppError.conflict('Còn share đang hoạt động — thu hồi share trước khi xóa vĩnh viễn');
		}
		const openUploads = await context.db.listOpenUploadSessions(200);
		const relatedUpload = openUploads.find((upload) => upload.objectKey === file.objectKey);
		if (relatedUpload) {
			throw AppError.conflict('Còn upload session liên quan — abort upload trước');
		}

		// Purge toàn bộ version của object ở B2 (nếu versioning bật).
		try {
			const versions = await context.storage.listObjectVersions(file.objectKey);
			for (const version of versions) {
				await context.storage.deleteObjectVersion(file.objectKey, version.versionId);
			}
			if (versions.length === 0) await context.storage.deleteObject(file.objectKey);
		} catch (error) {
			throw AppError.quota('Chưa xóa được object trên B2 — sẽ thử lại ở lần cron sau', 300);
		}
		await context.db.deleteFileRow(file.id);
		await recordAudit(context, {
			action: 'file.purge',
			actor: auth?.email ?? 'unknown',
			targetType: 'file',
			targetId: file.id,
			ip: c.get('clientIp'),
			metadata: { versionsPurged: true },
		});
		return json({ ok: true });
	});

	app.get('/:id/download', async (c) => {
		const mode = c.get('quotaMode');
		// Owner tải file của chính mình: luôn được phép, kể cả EMERGENCY.
		assertCapability(mode, 'allowOwnerDownload');
		const file = await context.db.getFile(c.req.param('id'));
		if (!file || file.deletedAt) throw AppError.notFound('Không tìm thấy file');
		const range = c.req.header('range');
		const upstream = await context.storage.getObject(file.objectKey, range);
		const headers = new Headers();
		headers.set('content-type', file.contentType || 'application/octet-stream');
		headers.set(
			'content-disposition',
			`attachment; filename*=UTF-8''${encodeRfc5987(file.name)}`,
		);
		headers.set('cache-control', 'private, no-store');
		headers.set('accept-ranges', 'bytes');
		const contentLength = upstream.headers.get('content-length');
		if (contentLength) headers.set('content-length', contentLength);
		const contentRange = upstream.headers.get('content-range');
		if (contentRange) headers.set('content-range', contentRange);
		return new Response(upstream.body, { status: upstream.status, headers });
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
