import { timingSafeEqual } from '@alkcloud/core';

export const CSRF_HEADER_NAME = 'x-alkcloud-csrf';

export interface OriginPolicy {
	allowedOrigins: string[];
	/** Bật/tắt kiểm tra Origin cho method không an toàn. */
	enforce: boolean;
}

const SAFE_METHODS = new Set(['GET', 'HEAD', 'OPTIONS']);

export function isSafeMethod(method: string): boolean {
	return SAFE_METHODS.has(method.toUpperCase());
}

/**
 * Kiểm tra Origin cho request thay đổi trạng thái.
 * - Origin bắt buộc phải có và nằm trong allowlist.
 * - `null` origin (sandbox, file://) bị từ chối.
 */
export function validateOrigin(request: Request, policy: OriginPolicy): { ok: boolean; reason?: string } {
	if (!policy.enforce || isSafeMethod(request.method)) return { ok: true };
	const origin = request.headers.get('origin');
	if (!origin) return { ok: false, reason: 'thiếu Origin header' };
	if (origin === 'null') return { ok: false, reason: 'Origin null không được phép' };
	if (!policy.allowedOrigins.includes(origin)) return { ok: false, reason: `Origin không được phép: ${origin}` };
	return { ok: true };
}

/** Synchronizer token: so sánh header CSRF với secret lưu trong session. */
export function validateCsrfToken(request: Request, expectedSecret: string | null): { ok: boolean; reason?: string } {
	if (isSafeMethod(request.method)) return { ok: true };
	if (!expectedSecret) return { ok: false, reason: 'thiếu CSRF secret trong session' };
	const provided = request.headers.get(CSRF_HEADER_NAME);
	if (!provided) return { ok: false, reason: 'thiếu CSRF token' };
	if (!timingSafeEqual(provided, expectedSecret)) return { ok: false, reason: 'CSRF token không hợp lệ' };
	return { ok: true };
}

/** Kiểm tra Referer/Origin chống clickjacking + rò rỉ token qua referrer. */
export function buildSecurityHeaders(options: {
	contentSecurityPolicy: string;
	allowOrigin?: string;
	frameOptions?: string;
}): Record<string, string> {
	const headers: Record<string, string> = {
		'content-security-policy': options.contentSecurityPolicy,
		'x-content-type-options': 'nosniff',
		'x-frame-options': options.frameOptions ?? 'DENY',
		'referrer-policy': 'no-referrer',
		'cross-origin-opener-policy': 'same-origin',
		'cross-origin-resource-policy': 'same-origin',
		'permissions-policy': 'camera=(), microphone=(), geolocation=(), interest-cohort=()',
		'strict-transport-security': 'max-age=31536000; includeSubDomains',
	};
	if (options.allowOrigin) {
		headers['access-control-allow-origin'] = options.allowOrigin;
		headers['access-control-allow-credentials'] = 'true';
		headers['vary'] = 'Origin';
	}
	return headers;
}
