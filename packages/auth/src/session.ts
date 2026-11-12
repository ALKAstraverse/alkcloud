import { newId, randomToken, sha256Hex } from '@alkcloud/core';

export const SESSION_COOKIE_NAME = '__Secure-alk_session';
export const SHARE_COOKIE_PREFIX = '__Secure-alk_share_';

export interface SessionTokenMaterial {
	token: string;
	tokenHash: string;
	sessionId: string;
	csrfSecret: string;
}

/** Token phiên ngẫu nhiên 256-bit; DB chỉ lưu hash SHA-256. */
export function createSessionMaterial(): SessionTokenMaterial {
	const token = randomToken(32);
	return {
		token,
		tokenHash: '',
		sessionId: newId('ses'),
		csrfSecret: randomToken(24),
	};
}

export async function hashSessionToken(token: string): Promise<string> {
	return sha256Hex(token);
}

export interface CookieOptions {
	maxAgeSeconds?: number;
	expires?: Date;
	path?: string;
	domain?: string;
	secure?: boolean;
	httpOnly?: boolean;
	sameSite?: 'Strict' | 'Lax' | 'None';
}

export function serializeCookie(name: string, value: string, options: CookieOptions = {}): string {
	const parts = [`${name}=${encodeURIComponent(value)}`];
	parts.push(`Path=${options.path ?? '/'}`);
	if (options.domain) parts.push(`Domain=${options.domain}`);
	if (options.maxAgeSeconds !== undefined) parts.push(`Max-Age=${Math.floor(options.maxAgeSeconds)}`);
	if (options.expires) parts.push(`Expires=${options.expires.toUTCString()}`);
	if (options.secure !== false) parts.push('Secure');
	if (options.httpOnly !== false) parts.push('HttpOnly');
	parts.push(`SameSite=${options.sameSite ?? 'Lax'}`);
	return parts.join('; ');
}

export function parseCookies(header: string | null | undefined): Record<string, string> {
	if (!header) return {};
	const cookies: Record<string, string> = {};
	for (const part of header.split(';')) {
		const index = part.indexOf('=');
		if (index <= 0) continue;
		const name = part.slice(0, index).trim();
		const value = part.slice(index + 1).trim();
		if (!name) continue;
		try {
			cookies[name] = decodeURIComponent(value);
		} catch {
			cookies[name] = value;
		}
	}
	return cookies;
}

export function buildSetCookieHeaders(cookies: string[]): string[] {
	return cookies;
}
