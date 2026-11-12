import { AppError, addDays, newId, randomToken, sha256Hex } from '@alkcloud/core';
import { Hono } from 'hono';
import { serializeCookie, verifyAuthKey } from '@alkcloud/auth';
import { shareCreateSchema, shareUpdateSchema, DEFAULT_SHARE_TTL_DAYS } from '@alkcloud/core';
import type { AppContext } from '../context.js';
import { recordAudit } from '../lib/audit.js';
import { json, parseJsonBody } from '../lib/http.js';
import { assertCapability, degradationHeaders } from '../lib/quota-guard.js';
import { requireOwner, type AppEnv } from '../middleware/auth.js';

export function createShareAdminRoutes(context: AppContext): Hono<AppEnv> {
	const app = new Hono<AppEnv>();
	app.use('*', requireOwner(context));

	app.get('/', async (c) => {
		const fileId = c.req.query('fileId');
		if (!fileId) throw AppError.badRequest('Thiếu fileId');
		const shares = await context.db.listSharesForFile(fileId);
		return json({
			shares: shares.map((share) => ({
				id: share.id,
				fileId: share.fileId,
				expiresAt: share.expiresAt,
				maxDownloads: share.maxDownloads,
				downloadCount: share.downloadCount,
				revokedAt: share.revokedAt,
				hasPassword: Boolean(share.passwordHash),
				createdAt: share.createdAt,
			})),
		});
	});

	app.post('/', async (c) => {
		const auth = c.get('auth');
		const mode = c.get('quotaMode');
		assertCapability(mode, 'allowNewShare');
		const body = await parseJsonBody(c.req.raw);
		const parsed = shareCreateSchema.safeParse(body);
		if (!parsed.success) throw AppError.badRequest('Dữ liệu share không hợp lệ');
		const input = parsed.data;

		const file = await context.db.getFile(input.fileId);
		if (!file || file.deletedAt) throw AppError.notFound('Không tìm thấy file');

		const token = randomToken(32);
		const tokenHash = await sha256Hex(token);
		// Fail closed: share có mật khẩu KHÔNG được tạo khi thiếu AUTH_PEPPER —
		// nếu không, hash chỉ là SHA-256(verifier) ⇒ brute-force offline dễ dàng.
		if (input.passwordVerifier && !context.config.authPepper) {
			throw AppError.notConfigured('AUTH_PEPPER chưa được cấu hình');
		}
		// SEC-03: salt per-share ĐƯỢC đưa vào hash. Trước đây salt lưu vào DB
		// nhưng KHÔNG dùng ⇒ mọi share có cùng mật khẩu đều cho cùng một hash,
		// và hash lưu trong D1 là preimage cố định cho wordlist.
		// Với salt, mỗi share có hash riêng ⇒ không dùng chung được rainbow table.
		const passwordHash = input.passwordVerifier
			? await sha256Hex(
					`${input.passwordVerifier}${input.passwordSalt ?? ''}${context.config.authPepper}`,
				)
			: null;

		const now = context.now().toISOString();
		const share = await context.db.createShare({
			id: newId('shr'),
			fileId: file.id,
			tokenHash,
			passwordHash,
			passwordSalt: input.passwordSalt ?? null,
			passwordParams: input.passwordParams ?? null,
			expiresAt: addDays(now, input.expiresInDays ?? DEFAULT_SHARE_TTL_DAYS),
			maxDownloads: input.maxDownloads ?? null,
			now,
		});
		await recordAudit(context, {
			action: 'share.create',
			actor: auth?.email ?? 'unknown',
			targetType: 'share',
			targetId: share.id,
			ip: c.get('clientIp'),
			metadata: { fileId: file.id, expiresAt: share.expiresAt, maxDownloads: share.maxDownloads },
		});
		return json(
			{
				share: {
					id: share.id,
					fileId: share.fileId,
					expiresAt: share.expiresAt,
					maxDownloads: share.maxDownloads,
					hasPassword: Boolean(share.passwordHash),
				},
				// Token nằm trong fragment (#) => KHÔNG bao giờ gửi lên server, không xuất hiện trong logs của Cloudflare.
				url: `${context.config.publicUrl}/s#${token}`,
				token,
				warning: 'Token share chỉ hiển thị một lần — hãy lưu lại URL.',
			},
			201,
			degradationHeaders(mode),
		);
	});

	app.patch('/:id', async (c) => {
		const auth = c.get('auth');
		const mode = c.get('quotaMode');
		const share = await context.db.getShareById(c.req.param('id'));
		if (!share) throw AppError.notFound('Không tìm thấy share');
		const body = await parseJsonBody(c.req.raw);
		const parsed = shareUpdateSchema.safeParse(body);
		if (!parsed.success) throw AppError.badRequest('Dữ liệu không hợp lệ');
		const now = context.now().toISOString();
		await context.db.updateShare(
			share.id,
			{
				...(parsed.data.expiresInDays !== undefined
					? { expiresAt: addDays(now, parsed.data.expiresInDays) }
					: {}),
				...(parsed.data.maxDownloads !== undefined ? { maxDownloads: parsed.data.maxDownloads } : {}),
			},
			now,
		);
		await recordAudit(context, {
			action: 'share.update',
			actor: auth?.email ?? 'unknown',
			targetType: 'share',
			targetId: share.id,
			ip: c.get('clientIp'),
			metadata: parsed.data,
		});
		return json({ ok: true, mode }, 200, degradationHeaders(mode));
	});

	app.delete('/:id', async (c) => {
		const auth = c.get('auth');
		const mode = c.get('quotaMode');
		const share = await context.db.getShareById(c.req.param('id'));
		if (!share) throw AppError.notFound('Không tìm thấy share');
		await context.db.revokeShare(share.id, context.now().toISOString());
		await recordAudit(context, {
			action: 'share.revoke',
			actor: auth?.email ?? 'unknown',
			targetType: 'share',
			targetId: share.id,
			ip: c.get('clientIp'),
		});
		return json({ ok: true, mode }, 200, degradationHeaders(mode));
	});

	return app;
}

export { verifyAuthKey };
