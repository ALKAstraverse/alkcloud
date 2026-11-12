import { AppError, sha256Hex, timingSafeEqual } from '@alkcloud/core';
import type { Context, MiddlewareHandler, Next } from 'hono';
import {
	SESSION_COOKIE_NAME,
	hashSessionToken,
	parseCookies,
	validateCsrfToken,
	validateOrigin,
} from '@alkcloud/auth';
import type { AppContext } from '../context.js';
import { readQuotaState } from '../context.js';
import { clientIp } from '../lib/http.js';
import type { DegradationMode, UsageState } from '@alkcloud/core';

export interface AuthenticatedSession {
	sessionId: string;
	ownerId: string;
	email: string;
	csrfSecret: string;
	expiresAt: string;
}

export type Vars = {
	auth: AuthenticatedSession | null;
	quotaMode: DegradationMode;
	quotaState: UsageState | null;
	clientIp: string;
};

export type AppEnv = { Variables: Vars };

export function sessionCookieValue(request: Request): string | null {
	const cookies = parseCookies(request.headers.get('cookie'));
	return cookies[SESSION_COOKIE_NAME] ?? null;
}

export async function resolveSession(context: AppContext, request: Request): Promise<AuthenticatedSession | null> {
	const token = sessionCookieValue(request);
	if (!token) return null;
	const tokenHash = await hashSessionToken(token);
	const session = await context.db.findSessionByTokenHash(tokenHash);
	if (!session) return null;
	if (session.revokedAt) return null;
	if (new Date(session.expiresAt).getTime() <= context.now().getTime()) return null;
	const owner = await context.db.getOwner();
	if (!owner) return null;
	return {
		sessionId: session.id,
		ownerId: session.ownerId,
		email: owner.email,
		csrfSecret: session.csrfSecret,
		expiresAt: session.expiresAt,
	};
}

/** Nạp degradation mode cho mọi route /api/v1 (kể cả public share). */
export function loadQuotaState(context: AppContext): MiddlewareHandler<AppEnv> {
	return async (c: Context<AppEnv>, next: Next) => {
		const state = await readQuotaState(context.db, context.config.quotaStateTtlSeconds);
		c.set('quotaMode', state?.mode ?? 'NORMAL');
		c.set('quotaState', state ?? null);
		c.set('clientIp', clientIp(c.req.raw));
		await next();
	};
}

/** Middleware bắt buộc owner đăng nhập + Origin + CSRF. */
export function requireOwner(context: AppContext): MiddlewareHandler<AppEnv> {
	return async (c: Context<AppEnv>, next: Next) => {
		const originCheck = validateOrigin(c.req.raw, {
			allowedOrigins: context.config.allowedOrigins,
			enforce: true,
		});
		if (!originCheck.ok) {
			throw AppError.forbidden(originCheck.reason ?? 'Origin không hợp lệ');
		}

		const auth = await resolveSession(context, c.req.raw);
		if (!auth) throw AppError.unauthorized();

		const csrf = validateCsrfToken(c.req.raw, auth.csrfSecret);
		if (!csrf.ok) {
			throw AppError.forbidden(csrf.reason ?? 'CSRF không hợp lệ');
		}

		c.set('auth', auth);
		await next();
	};
}

export async function constantTimeEquals(a: string, b: string): Promise<boolean> {
	if (timingSafeEqual(a, b)) return true;
	return (await sha256Hex(a)) === (await sha256Hex(b));
}
