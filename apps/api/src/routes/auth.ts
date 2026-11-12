import { MemoryRateLimiter, DEFAULT_POLICIES } from '@alkcloud/auth';
import { AppError, addDays, newId, randomToken, sha256Hex, timingSafeEqual } from '@alkcloud/core';
import { Hono } from 'hono';
import {
	SESSION_COOKIE_NAME,
	formatRecoveryCode,
	validateOrigin,
	generateRecoveryCodes,
	hashRecoveryCode,
	hashSessionToken,
	serializeCookie,
	verifyAuthKey,
} from '@alkcloud/auth';
import {
	bootstrapSchema,
	changePasswordSchema,
	loginSchema,
	recoveryLoginSchema,
	SESSION_TTL_DAYS,
} from '@alkcloud/core';
import type { AppContext } from '../context.js';
import { recordAudit } from '../lib/audit.js';
import { clientIp, json, parseJsonBody } from '../lib/http.js';
import { resolveSession, requireOwner, type AppEnv } from '../middleware/auth.js';

export function createAuthRoutes(context: AppContext): Hono<AppEnv> {
	const app = new Hono<AppEnv>();

	/**
	 * Origin check cho các endpoint public-but-stateful (bootstrap / login /
	 * recovery-login). Không có cookie ⇒ không dùng được `requireOwner`
	 * (CSRF token), nhưng endpoint này SET cookie session ⇒ nếu không kiểm
	 * Origin, một trang web khác có thể ép trình duyệt nạn nhân đăng nhập
	 * (login CSRF) hoặc đốt mã khôi phục.
	 */
	const requireTrustedOrigin = (request: Request): void => {
		const originCheck = validateOrigin(request, {
			allowedOrigins: context.config.allowedOrigins,
			enforce: true,
		});
		if (!originCheck.ok) throw AppError.forbidden(originCheck.reason ?? 'Origin không hợp lệ');
	};

	// Limiter theo instance Worker (mỗi isolate một bộ). Lớp authoritative vẫn là
	// Cloudflare Rate Limiting Rule vì isolate không chia sẻ state giữa PoP.
	// Limiter theo IP: key KHÔNG chứa email (attacker kiểm soát email ⇒ đổi email
	// để né limiter và rò bộ nhớ của isolate). Xem SEC-15.
	const loginLimiter = new MemoryRateLimiter(DEFAULT_POLICIES.login.limit, DEFAULT_POLICIES.login.windowMs);
	// Limiter theo TÀI KHOẢN: chỉ có đúng 1 owner ⇒ đây là lớp bảo vệ duy nhất
	// chống brute-force khi attacker xoay nhiều IP. Rộng hơn limiter theo IP
	// để owner đổi mạng/VPN không bị chặn nhầm.
	const accountLoginLimiter = new MemoryRateLimiter(
		DEFAULT_POLICIES.loginAccount.limit,
		DEFAULT_POLICIES.loginAccount.windowMs,
	);
	const recoveryLimiter = new MemoryRateLimiter(
		DEFAULT_POLICIES.recoveryLogin.limit,
		DEFAULT_POLICIES.recoveryLogin.windowMs,
	);
	const bootstrapLimiter = new MemoryRateLimiter(
		DEFAULT_POLICIES.bootstrap.limit,
		DEFAULT_POLICIES.bootstrap.windowMs,
	);

	const issueSession = async (ownerId: string, email: string, userAgent: string | null) => {
		const token = randomToken(32);
		const tokenHash = await hashSessionToken(token);
		const csrfSecret = randomToken(24);
		const sessionId = newId('ses');
		const now = context.now();
		const expiresAt = addDays(now.toISOString(), SESSION_TTL_DAYS);
		await context.db.createSession({
			id: sessionId,
			ownerId,
			tokenHash,
			csrfSecret,
			createdAt: now.toISOString(),
			expiresAt,
			userAgent: userAgent?.slice(0, 255) ?? null,
		});
		const cookie = serializeCookie(SESSION_COOKIE_NAME, token, {
			maxAgeSeconds: SESSION_TTL_DAYS * 24 * 60 * 60,
			httpOnly: true,
			secure: true,
			sameSite: 'Lax',
			path: '/',
		});
		return { sessionId, token, csrfSecret, expiresAt, cookie };
	};

	/**
	 * Trả salt + params Argon2id của owner để client dẫn xuất lại `authKey`.
	 *
	 * Salt KHÔNG phải bí mật (theo thiết kế Argon2id — nó chỉ chống rainbow table).
	 * Việc bảo vệ offline brute-force do `AUTH_PEPPER` đảm nhiệm: thiếu pepper thì
	 * attacker không thể tính `SHA-256(authKey + pepper)` để so khớp.
	 *
	 * Endpoint luôn trả về cùng một salt bất kể email có tồn tại hay không ⇒ không lộ
	 * việc email nào đã đăng ký.
	 */
	app.get('/params', async (c) => {
		const owner = await context.db.getOwner();
		return json({
			salt: owner?.authVerifierSalt ?? '',
			params: owner?.authParams ?? '',
		});
	});

	app.get('/status', async (c) => {
		const owner = await context.db.getOwner();
		// KHÔNG trả email owner: endpoint này public, email là PII và việc trả nó
		// cũng làm lộ email đúng/sai khi thử đăng nhập (user enumeration).
		return json({
			bootstrapped: Boolean(owner),
			turnstileEnabled: Boolean(context.config.turnstileSiteKey),
			environment: context.config.environment,
		});
	});

	app.post('/bootstrap', async (c) => {
		requireTrustedOrigin(c.req.raw);
		const body = await parseJsonBody(c.req.raw);
		const parsed = bootstrapSchema.safeParse(body);
		if (!parsed.success) throw AppError.badRequest('Dữ liệu bootstrap không hợp lệ');

		if (!context.config.bootstrapSetupToken) {
			throw AppError.notConfigured('BOOTSTRAP_SETUP_TOKEN chưa được cấu hình');
		}
		// So sánh constant-time — `!==` dừng ở ký tự khác nhau đầu tiên ⇒
		// timing oracle nhỏ (nhưng đủ để đoán dần token khi rate limit yếu).
		if (!timingSafeEqual(parsed.data.setupToken, context.config.bootstrapSetupToken)) {
			throw AppError.forbidden('setup token không hợp lệ');
		}
		if (!context.config.authPepper) {
			throw AppError.notConfigured('AUTH_PEPPER chưa được cấu hình');
		}
		const existing = await context.db.countOwners();
		if (existing > 0) throw AppError.conflict('Owner đã được bootstrap');

		const bootstrapDecision = bootstrapLimiter.consume(`bootstrap:${clientIp(c.req.raw)}`, context.now().getTime());
		if (!bootstrapDecision.allowed) {
			throw AppError.rateLimited(
				`Quá nhiều lần khởi tạo. Thử lại sau ${bootstrapDecision.retryAfterSeconds}s.`,
				bootstrapDecision.retryAfterSeconds,
			);
		}

		const now = context.now().toISOString();
		const ownerId = newId('own');
		const verifier = await sha256Hex(`${parsed.data.authKey}${context.config.authPepper}`);
		const owner = await context.db.createOwner({
			id: ownerId,
			email: parsed.data.email.toLowerCase(),
			authVerifierHash: verifier,
			authVerifierSalt: parsed.data.authVerifierSalt,
			authParams: parsed.data.authParams,
			createdAt: now,
		}).catch((error: unknown) => {
			// Unique index `idx_owner_singleton` chặn race 2 request bootstrap đồng thời
			// (countOwners rồi createOwner là 2 bước, không atomic).
			const raw = error instanceof Error ? error.message : String(error);
			if (/UNIQUE constraint failed/i.test(raw)) throw AppError.conflict('Owner đã được bootstrap');
			throw error;
		});

		const pepper = context.config.authPepper;
		if (!pepper) throw AppError.notConfigured('AUTH_PEPPER chưa được cấu hình');
		const recovery = generateRecoveryCodes(pepper);
		const recoveryWithHashes = await Promise.all(
			recovery.map(async (item) => ({ id: item.id, codeHash: await hashRecoveryCode(item.code, pepper) })),
		);
		await context.db.replaceRecoveryCodes(ownerId, recoveryWithHashes, now);

		const session = await issueSession(owner.id, owner.email, c.req.header('user-agent') ?? null);
		await recordAudit(context, {
			action: 'auth.bootstrap',
			actor: owner.email,
			targetType: 'owner',
			targetId: owner.id,
			ip: clientIp(c.req.raw),
		});

		return json(
			{
				owner: { id: owner.id, email: owner.email },
				session: { csrfToken: session.csrfSecret, expiresAt: session.expiresAt },
				recoveryCodes: recovery.map((item) => item.code),
				warning: 'Lưu recovery codes ngay — chỉ hiển thị một lần.',
			},
			201,
			{ 'set-cookie': session.cookie },
		);
	});

	app.post('/login', async (c) => {
		requireTrustedOrigin(c.req.raw);
		const body = await parseJsonBody(c.req.raw);
		const parsed = loginSchema.safeParse(body);
		if (!parsed.success) throw AppError.badRequest('Dữ liệu đăng nhập không hợp lệ');
		if (!context.config.authPepper) throw AppError.notConfigured('AUTH_PEPPER chưa được cấu hình');

		const ip = clientIp(c.req.raw);
		// Chặn theo IP (chống spray) VÀ theo tài khoản (chống xoay IP).
		const ipDecision = loginLimiter.consume(`login:${ip}`, context.now().getTime());
		const accountDecision = accountLoginLimiter.consume(
			`login:account:${parsed.data.email.toLowerCase()}`,
			context.now().getTime(),
		);
		const decision = ipDecision.allowed ? accountDecision : ipDecision;
		if (!decision.allowed) {
			await recordAudit(context, {
				action: 'auth.login.failure',
				actor: parsed.data.email.toLowerCase(),
				ip,
				metadata: { reason: 'rate_limited' },
			});
			throw AppError.rateLimited(
				`Quá nhiều lần đăng nhập. Thử lại sau ${decision.retryAfterSeconds}s.`,
				decision.retryAfterSeconds,
			);
		}

		const owner = await context.db.getOwner();
		if (!owner) throw AppError.unauthorized('Tài khoản chưa được khởi tạo');

		const email = parsed.data.email.toLowerCase();
		if (owner.email !== email) {
			await recordAudit(context, {
				action: 'auth.login.failure',
				actor: email,
				ip,
				metadata: { reason: 'email_mismatch' },
			});
			throw AppError.unauthorized('Thông tin đăng nhập không hợp lệ');
		}

		const valid = await verifyAuthKey(parsed.data.authKey, context.config.authPepper, owner.authVerifierHash);
		if (!valid) {
			await recordAudit(context, {
				action: 'auth.login.failure',
				actor: email,
				ip,
				metadata: { reason: 'invalid_auth_key' },
			});
			throw AppError.unauthorized('Thông tin đăng nhập không hợp lệ');
		}

		const session = await issueSession(owner.id, owner.email, c.req.header('user-agent') ?? null);
		await recordAudit(context, {
			action: 'auth.login.success',
			actor: owner.email,
			targetType: 'session',
			targetId: session.sessionId,
			ip,
		});
		return json(
			{ owner: { id: owner.id, email: owner.email }, session: { csrfToken: session.csrfSecret, expiresAt: session.expiresAt } },
			200,
			{ 'set-cookie': session.cookie },
		);
	});

	app.post('/recovery-login', async (c) => {
		requireTrustedOrigin(c.req.raw);
		const body = await parseJsonBody(c.req.raw);
		const parsed = recoveryLoginSchema.safeParse(body);
		if (!parsed.success) throw AppError.badRequest('Dữ liệu không hợp lệ');
		if (!context.config.authPepper) throw AppError.notConfigured('AUTH_PEPPER chưa được cấu hình');

		// Mã khôi phục BỎ QUA Argon2id — nó là bearer secret 1 lần dùng.
		// Không có limiter ⇒ attacker thử vô hạn (đồng thời đốt cả 10 mã của owner).
		const ip = clientIp(c.req.raw);
		const recoveryDecision = recoveryLimiter.consume(`recovery:${ip}`, context.now().getTime());
		if (!recoveryDecision.allowed) {
			await recordAudit(context, {
				action: 'auth.login.failure',
				actor: parsed.data.email.toLowerCase(),
				ip,
				metadata: { reason: 'rate_limited', channel: 'recovery' },
			});
			throw AppError.rateLimited(
				`Quá nhiều lần thử mã khôi phục. Thử lại sau ${recoveryDecision.retryAfterSeconds}s.`,
				recoveryDecision.retryAfterSeconds,
			);
		}

		const owner = await context.db.getOwner();
		if (!owner || owner.email !== parsed.data.email.toLowerCase()) {
			// Phải audit cả nhánh email sai — nếu không, việc dò email đúng/sai
			// không để lại dấu vết nào trong audit log.
			await recordAudit(context, {
				action: 'auth.login.failure',
				actor: parsed.data.email.toLowerCase(),
				ip,
				metadata: { reason: 'email_mismatch', channel: 'recovery' },
			});
			throw AppError.unauthorized('Thông tin đăng nhập không hợp lệ');
		}
		const codeHash = await hashRecoveryCode(formatRecoveryCode(parsed.data.code), context.config.authPepper);
		const consumed = await context.db.consumeRecoveryCode(owner.id, codeHash, context.now().toISOString());
		if (!consumed) {
			await recordAudit(context, {
				action: 'auth.login.failure',
				actor: owner.email,
				ip: clientIp(c.req.raw),
				metadata: { reason: 'invalid_recovery_code' },
			});
			throw AppError.unauthorized('Mã khôi phục không hợp lệ');
		}
		const session = await issueSession(owner.id, owner.email, c.req.header('user-agent') ?? null);
		await recordAudit(context, {
			action: 'auth.recovery_code.use',
			actor: owner.email,
			targetType: 'session',
			targetId: session.sessionId,
			ip: clientIp(c.req.raw),
		});
		// Vào bằng recovery code = dấu hiệu mất quyền kiểm soát / tài khoản bị chiếm
		// ⇒ thu hồi toàn bộ session cũ, chỉ giữ session vừa tạo.
		await context.db.revokeAllSessions(owner.id, context.now().toISOString(), session.sessionId);
		return json(
			{ owner: { id: owner.id, email: owner.email }, session: { csrfToken: session.csrfSecret, expiresAt: session.expiresAt } },
			200,
			{ 'set-cookie': session.cookie },
		);
	});

	app.post('/logout', async (c) => {
		// Logout vẫn phải chặn CSRF (Origin check) — nếu không, site khác có thể
		// ép đăng xuất nạn nhân (DoS nhỏ nhưng không cần thiết phải chấp nhận).
		const originCheck = validateOrigin(c.req.raw, {
			allowedOrigins: context.config.allowedOrigins,
			enforce: true,
		});
		if (!originCheck.ok) throw AppError.forbidden(originCheck.reason ?? 'Origin không hợp lệ');
		const auth = await resolveSession(context, c.req.raw);
		if (auth) {
			await context.db.revokeSession(auth.sessionId, context.now().toISOString());
			await recordAudit(context, {
				action: 'auth.logout',
				actor: auth.email,
				targetType: 'session',
				targetId: auth.sessionId,
				ip: clientIp(c.req.raw),
			});
		}
		const cookie = serializeCookie(SESSION_COOKIE_NAME, '', {
			maxAgeSeconds: 0,
			httpOnly: true,
			secure: true,
			sameSite: 'Lax',
			path: '/',
		});
		return json({ ok: true }, 200, { 'set-cookie': cookie });
	});

	app.get('/session', async (c) => {
		const auth = await resolveSession(context, c.req.raw);
		if (!auth) throw AppError.unauthorized();
		const owner = await context.db.getOwner();
		const unusedCodes = owner ? await context.db.countUnusedRecoveryCodes(owner.id) : 0;
		return json({
			owner: owner ? { id: owner.id, email: owner.email } : null,
			session: { id: auth.sessionId, expiresAt: auth.expiresAt, csrfToken: auth.csrfSecret },
			recoveryCodesRemaining: unusedCodes,
		});
	});

	app.post('/password', requireOwner(context), async (c) => {
		const auth = c.get('auth');
		if (!auth) throw AppError.unauthorized();
		if (!context.config.authPepper) throw AppError.notConfigured('AUTH_PEPPER chưa được cấu hình');
		const body = await parseJsonBody(c.req.raw);
		const parsed = changePasswordSchema.safeParse(body);
		if (!parsed.success) throw AppError.badRequest('Dữ liệu không hợp lệ');

		const owner = await context.db.getOwner();
		if (!owner) throw AppError.notFound('Owner không tồn tại');
		const valid = await verifyAuthKey(parsed.data.currentAuthKey, context.config.authPepper, owner.authVerifierHash);
		if (!valid) throw AppError.forbidden('Mật khẩu hiện tại không đúng');

		const now = context.now().toISOString();
		const verifier = await sha256Hex(`${parsed.data.newAuthKey}${context.config.authPepper}`);
		await context.db.updateOwnerAuth(
			owner.id,
			verifier,
			parsed.data.newAuthVerifierSalt,
			parsed.data.newAuthParams,
			now,
		);
		await context.db.revokeAllSessions(owner.id, now, auth.sessionId);
		const pepper = context.config.authPepper;
		if (!pepper) throw AppError.notConfigured('AUTH_PEPPER chưa được cấu hình');
		const recovery = generateRecoveryCodes(pepper);
		const recoveryWithHashes = await Promise.all(
			recovery.map(async (item) => ({ id: item.id, codeHash: await hashRecoveryCode(item.code, pepper) })),
		);
		await context.db.replaceRecoveryCodes(owner.id, recoveryWithHashes, now);
		await recordAudit(context, {
			action: 'auth.password.change',
			actor: owner.email,
			targetType: 'owner',
			targetId: owner.id,
			ip: clientIp(c.req.raw),
			metadata: { recoveryCodesRegenerated: recovery.length },
		});
		return json({ ok: true, recoveryCodes: recovery.map((item) => item.code) });
	});

	app.post('/recovery-codes/regenerate', requireOwner(context), async (c) => {
		const auth = c.get('auth');
		if (!auth) throw AppError.unauthorized();
		if (!context.config.authPepper) throw AppError.notConfigured('AUTH_PEPPER chưa được cấu hình');
		const owner = await context.db.getOwner();
		if (!owner) throw AppError.notFound('Owner không tồn tại');
		const now = context.now().toISOString();
		const pepper = context.config.authPepper;
		if (!pepper) throw AppError.notConfigured('AUTH_PEPPER chưa được cấu hình');
		const recovery = generateRecoveryCodes(pepper);
		const recoveryWithHashes = await Promise.all(
			recovery.map(async (item) => ({ id: item.id, codeHash: await hashRecoveryCode(item.code, pepper) })),
		);
		await context.db.replaceRecoveryCodes(owner.id, recoveryWithHashes, now);
		await recordAudit(context, {
			action: 'auth.recovery_code.reset',
			actor: owner.email,
			targetType: 'owner',
			targetId: owner.id,
			ip: clientIp(c.req.raw),
		});
		return json({ recoveryCodes: recovery.map((item) => item.code) });
	});

	app.get('/sessions', requireOwner(context), async (c) => {
		const auth = c.get('auth');
		if (!auth) throw AppError.unauthorized();
		const sessions = await context.db.listSessions(auth.ownerId);
		return json({
			sessions: sessions.map((session) => ({
				id: session.id,
				createdAt: session.createdAt,
				lastSeenAt: session.lastSeenAt,
				expiresAt: session.expiresAt,
				revokedAt: session.revokedAt,
				userAgent: session.userAgent,
				current: session.id === auth.sessionId,
			})),
		});
	});

	app.delete('/sessions/:id', requireOwner(context), async (c) => {
		const auth = c.get('auth');
		if (!auth) throw AppError.unauthorized();
		const sessionId = c.req.param('id');
		const now = context.now().toISOString();
		await context.db.revokeSession(sessionId, now);
		await recordAudit(context, {
			action: 'auth.session.revoke',
			actor: auth.email,
			targetType: 'session',
			targetId: sessionId,
			ip: clientIp(c.req.raw),
		});
		return json({ ok: true });
	});

	return app;
}
