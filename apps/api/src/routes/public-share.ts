import { AppError, hmacHex, sha256Hex, timingSafeEqual } from '@alkcloud/core';
import { Hono } from 'hono';
import { MemoryRateLimiter, DEFAULT_POLICIES, serializeCookie, parseCookies } from '@alkcloud/auth';
import type { AppContext } from '../context.js';
import { recordAudit } from '../lib/audit.js';
import { clientIp, encodeRfc5987, json, parseJsonBody } from '../lib/http.js';
import { assertCapability, degradationHeaders } from '../lib/quota-guard.js';
import { assertRangeSatisfiable } from '../lib/range.js';
import { isServerSideStorageFailure } from '../lib/storage-error.js';
import type { AppEnv } from '../middleware/auth.js';
import { shareUnlockSchema } from '@alkcloud/core';

/** Token share KHÔNG nằm trong path — luôn gửi qua header `x-share-token`. */
const SHARE_TOKEN_HEADER = 'x-share-token';
// Grant cũng nhận qua header: share page (`cloud.alk.xx.kg`) gọi API
// (`api.alk.xx.kg`) là cross-site nên cookie SameSite=Lax KHÔNG được gửi kèm.
const SHARE_GRANT_HEADER = 'x-share-grant';
const SHARE_COOKIE_PREFIX = '__Secure-alk_share_';

export function createPublicShareRoutes(context: AppContext): Hono<AppEnv> {
	const app = new Hono<AppEnv>();

	// Fail closed: toàn bộ endpoint share cần AUTH_PEPPER để ký grant (HMAC) và
	// để băm mật khẩu. Thiếu pepper => KHÔNG dùng hằng số công khai làm khoá
	// (grant có thể bị giả mạo) ⇒ trả 503 NOT_CONFIGURED thay vì chạy yếu.
	app.use('*', async (c, next) => {
		if (!context.config.authPepper) {
			throw AppError.notConfigured('AUTH_PEPPER chưa được cấu hình');
		}
		await next();
	});

	// Limiter phải là instance-level: module-level sẽ dùng chung state giữa các
	// app instance (và giữa các test), gây nhiễu rate-limit ngoài ý muốn.
	const unlockPolicy = context.rateLimits?.shareUnlock ?? DEFAULT_POLICIES.shareUnlock;
	const unlockLimiter = new MemoryRateLimiter(
		unlockPolicy.limit,
		unlockPolicy.windowMs,
	);

	const resolveShare = async (request: Request) => {
		const token = request.headers.get(SHARE_TOKEN_HEADER);
		if (!token) throw AppError.unauthorized('Thiếu share token');
		const tokenHash = await sha256Hex(token);
		const share = await context.db.getShareByTokenHash(tokenHash);
		if (!share) throw AppError.notFound('Share không tồn tại');
		if (share.revokedAt) throw AppError.notFound('Share đã bị thu hồi');
		if (new Date(share.expiresAt).getTime() <= context.now().getTime()) throw AppError.notFound('Share đã hết hạn');
		return { share, token };
	};

	const shareCookieName = (shareId: string) => `${SHARE_COOKIE_PREFIX}${shareId}`;

	const signShareGrant = async (shareId: string, expiresAtMs: number): Promise<string> => {
		const payload = `${shareId}.${expiresAtMs}`;
		const signature = await hmacHex(context.config.authPepper!, payload);
		return `${payload}.${signature}`;
	};

	const verifyShareGrant = async (cookieValue: string, shareId: string): Promise<boolean> => {
		const [cookieShareId, expiresAtRaw, signature] = cookieValue.split('.');
		if (!cookieShareId || !expiresAtRaw || !signature) return false;
		if (cookieShareId !== shareId) return false;
		if (Number(expiresAtRaw) <= context.now().getTime()) return false;
		const expected = await hmacHex(context.config.authPepper!, `${cookieShareId}.${expiresAtRaw}`);
		return timingSafeEqual(expected, signature);
	};

	app.get('/share/info', async (c) => {
		const { share } = await resolveShare(c.req.raw);
		const file = await context.db.getFile(share.fileId);
		if (!file || file.deletedAt) throw AppError.notFound('File không còn tồn tại');

		// Share có mật khẩu: KHÔNG lộ metadata (tên file, kích thước, content-type)
		// trước khi người dùng mở khoá — nếu không, kẻ tấn công chỉ cần token là
	// biết tên + kích thước file mà không cần mật khẩu.
		let unlocked = true;
		if (share.passwordHash) {
			const headerGrant = c.req.header(SHARE_GRANT_HEADER);
			const cookies = parseCookies(c.req.header('cookie'));
			const grant = headerGrant ?? cookies[shareCookieName(share.id)];
			unlocked = grant ? await verifyShareGrant(grant, share.id) : false;
		}

		return json({
			share: {
				fileName: unlocked ? file.name : null,
				size: unlocked ? file.size : null,
				contentType: unlocked ? file.contentType : null,
				requiresPassword: Boolean(share.passwordHash),
				unlocked,
				expiresAt: share.expiresAt,
				maxDownloads: share.maxDownloads,
				downloadCount: share.downloadCount,
				downloadsRemaining:
					share.maxDownloads === null ? null : Math.max(0, share.maxDownloads - share.downloadCount),
			},
		});
	});

	app.post('/share/unlock', async (c) => {
		const ip = clientIp(c.req.raw);
		const decision = unlockLimiter.consume(`unlock:${ip}`);
		if (!decision.allowed) {
			throw AppError.rateLimited('Quá nhiều lần thử mật khẩu share', decision.retryAfterSeconds);
		}
		const { share } = await resolveShare(c.req.raw);
		const body = await parseJsonBody(c.req.raw).catch(() => ({}));
		const parsed = shareUnlockSchema.safeParse(body);
		const provided = parsed.success ? parsed.data.passwordVerifier : undefined;

		if (share.passwordHash) {
			// Cùng công thức với lúc tạo share: verifier || salt || pepper.
			// `share.passwordSalt` là salt do client sinh khi tạo share (lưu trong D1).
			const candidate = provided
				? await sha256Hex(`${provided}${share.passwordSalt ?? ''}${context.config.authPepper!}`)
				: null;
			if (!candidate || !timingSafeEqual(candidate, share.passwordHash)) {
				await recordAudit(context, {
					action: 'share.unlock.failure',
					actor: 'public',
					targetType: 'share',
					targetId: share.id,
					ip,
				});
				throw AppError.forbidden('Mật khẩu share không đúng');
			}
		}

		const expiresAtMs = Math.min(
			new Date(share.expiresAt).getTime(),
			context.now().getTime() + 60 * 60 * 1000,
		);
		const grant = await signShareGrant(share.id, expiresAtMs);
		const cookie = serializeCookie(shareCookieName(share.id), grant, {
			maxAgeSeconds: Math.max(60, Math.floor((expiresAtMs - context.now().getTime()) / 1000)),
			httpOnly: true,
			secure: true,
			sameSite: 'Lax',
			path: '/',
		});
		await recordAudit(context, {
			action: 'share.unlock',
			actor: 'public',
			targetType: 'share',
			targetId: share.id,
			ip,
		});
		const file = await context.db.getFile(share.fileId);
		return json(
			{
				share: {
					fileName: file?.name ?? null,
					size: file?.size ?? 0,
					contentType: file?.contentType ?? 'application/octet-stream',
					expiresAt: share.expiresAt,
					requiresPassword: Boolean(share.passwordHash),
					unlocked: true,
					maxDownloads: share.maxDownloads,
					downloadCount: share.downloadCount,
					downloadsRemaining:
						share.maxDownloads === null ? null : Math.max(0, share.maxDownloads - share.downloadCount),
				},
				// Trả grant trong body để client cross-site gửi qua header (cookie
				// SameSite=Lax không đi kèm request cross-site).
				grant,
			},
			200,
			{ 'set-cookie': cookie },
		);
	});

	app.get('/share/download', async (c) => {
		const mode = c.get('quotaMode') ?? 'NORMAL';
		assertCapability(mode, 'allowPublicShareDownload');
		const { share, token } = await resolveShare(c.req.raw);

		if (share.passwordHash) {
			const headerGrant = c.req.header(SHARE_GRANT_HEADER);
			const cookies = parseCookies(c.req.header('cookie'));
			const cookieGrant = cookies[shareCookieName(share.id)];
			const provided = headerGrant ?? cookieGrant;
			const valid = provided ? await verifyShareGrant(provided, share.id) : false;
			if (!valid) {
				throw AppError.forbidden('Cần mở khóa share trước khi tải');
			}
		}

		const file = await context.db.getFile(share.fileId);
		if (!file || file.deletedAt) throw AppError.notFound('File không còn tồn tại');

		// SEC-02: kiểm tra Range TRƯỚC khi tăng bộ đếm.
		// Nếu không, client gửi Range không thỏa mãn (vd bytes=999999999-) ⇒ B2 trả
		// 416 ⇒ route hoàn lại lượt tải ⇒ attacker reset được bộ đếm và tải
		// vô hạn lần dù share có maxDownloads.
		const range = assertRangeSatisfiable(c.req.header('range'), file.size);

		// Tăng bộ đếm download ngay khi cấp quyền tải (atomic, có điều kiện max_downloads).
		const allowed = await context.db.incrementShareDownload(share.id, context.now().toISOString());
		if (!allowed) throw AppError.forbidden('Share đã đạt giới hạn tải');

		let upstream: Response;
		try {
			upstream = await context.storage.getObject(file.objectKey, range ?? undefined);
		} catch (error) {
			// Chỉ hoàn lại lượt tải khi lỗi do HẠ TẦNG (5xx / mạng). Lỗi 4xx là do
			// client ⇒ KHÔNG hoàn (nếu không, lỗi 416 sẽ reset được bộ đếm).
			if (isServerSideStorageFailure(error)) {
				await context.db.decrementShareDownload(share.id, context.now().toISOString());
			}
			throw error;
		}
		if (upstream.status >= 400) {
			if (upstream.status >= 500) {
				await context.db.decrementShareDownload(share.id, context.now().toISOString());
			}
			throw AppError.notFound('File không còn tồn tại');
		}
		const headers = new Headers();
		headers.set('content-type', file.contentType || 'application/octet-stream');
		headers.set('content-disposition', `attachment; filename*=UTF-8''${encodeRfc5987(file.name)}`);
		headers.set('cache-control', 'private, no-store');
		headers.set('accept-ranges', 'bytes');
		const contentLength = upstream.headers.get('content-length');
		if (contentLength) headers.set('content-length', contentLength);
		const contentRange = upstream.headers.get('content-range');
		if (contentRange) headers.set('content-range', contentRange);
		return new Response(upstream.body, {
			status: upstream.status,
			headers: { ...Object.fromEntries(headers.entries()), 'x-share-token': 'redacted' },
		});
	});

	app.get('/share/resolve', async (c) => {
		// Endpoint cho share page: token nằm trong query của share page nhưng không đưa vào logs.
		const { share } = await resolveShare(c.req.raw);
		return json({ shareId: share.id, expiresAt: share.expiresAt }, 200, degradationHeaders('NORMAL'));
	});

	return app;
}
