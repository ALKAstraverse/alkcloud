/**
 * Worker tĩnh cho AlkCloud web.
 *
 * Mục đích duy nhất: phục vụ SPA + áp dụng security headers.
 * Route `cloud.alk.xx.kg/*` sẽ trỏ tới Worker này (chưa bật — cần owner duyệt).
 */

interface Env {
	ASSETS: {
		fetch(request: Request): Promise<Response>;
	};
}

const SECURITY_HEADERS: Record<string, string> = {
	'x-content-type-options': 'nosniff',
	'x-frame-options': 'DENY',
	'referrer-policy': 'no-referrer',
	'strict-transport-security': 'max-age=31536000; includeSubDomains',
	'content-security-policy':
		"default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; " +
		"img-src 'self' data:; font-src 'self'; connect-src 'self' https://api.alk.xx.kg; " +
		"object-src 'none'; base-uri 'none'; form-action 'self'; frame-ancestors 'none'",
	'permissions-policy': 'camera=(), microphone=(), geolocation=()',
	'cross-origin-opener-policy': 'same-origin',
};

export default {
	async fetch(request: Request, env: Env): Promise<Response> {
		const response = await env.ASSETS.fetch(request);
		const headers = new Headers(response.headers);
		for (const [key, value] of Object.entries(SECURITY_HEADERS)) {
			headers.set(key, value);
		}
		// Share page: không bao giờ cache ở CDN (token nằm trong fragment, trang tĩnh).
		headers.set('cache-control', 'no-store');
		headers.set('x-robots-tag', 'noindex, nofollow');
		return new Response(response.body, {
			status: response.status,
			statusText: response.statusText,
			headers,
		});
	},
};
