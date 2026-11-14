/**
 * Worker tĩnh cho AlkCloud web.
 *
 * Mục đích: phục vụ SPA + áp dụng security headers.
 *
 * GHI CHÚ VỀ CSP: CSP do Worker này đặt và **có hiệu lực** (đã kiểm chứng: URL chưa
 * từng bị cache trả đúng CSP của app). Nhưng **cache edge của zone** phục vụ lại
 * response cũ (HTML + header) kể cả khi client gửi `Cache-Control: no-cache` ⇒
 * sau mỗi lần deploy, người dùng có thể vẫn chạy bundle cũ (và CSP cũ).
 *
 * ⇒ Vì vậy `/` **redirect** tới `/app/<version>/` (version = hash bundle hiện tại):
 *   - mỗi lần deploy là một path mới ⇒ cache key mới ⇒ luôn lấy bản mới;
 *   - kể cả khi response 307 bị cache (Location cũ), path đó vẫn phục vụ SPA của
 *     deployment **hiện tại** ⇒ người dùng luôn chạy code mới nhất.
 *
 * Web app không được phụ thuộc vào việc CSP có cho phép host nào ngoài `self` và
 * `api.alk.xx.kg`:
 *   - Upload đi qua API (`POST /api/v1/uploads/:id/content`) rồi API chuyển tiếp
 *     tới B2 qua relay ⇒ không cần `connect-src` tới host B2.
 *   - Download dùng `location.assign` (navigation) ⇒ không bị `connect-src` chặn.
 */

interface Env {
	ASSETS: {
		fetch(request: Request): Promise<Response>;
	};
}

/**
 * Version của deployment hiện tại = hash trong tên bundle (`index-<hash>.js`).
 * Cache theo isolate: chỉ đọc `index.html` **một lần** cho mỗi isolate.
 */
let versionPromise: Promise<string> | null = null;

function getVersion(env: Env): Promise<string> {
	versionPromise ??= env.ASSETS.fetch(new Request('https://assets.local/index.html'))
		.then((response) => (response.ok ? response.text() : ''))
		.then((html) => {
			const match = html.match(/\/assets\/index-([A-Za-z0-9_-]+)\.js/);
			return match?.[1] ?? 'dev';
		})
		.catch(() => 'dev');
	return versionPromise;
}

const SECURITY_HEADERS: Record<string, string> = {
	'x-content-type-options': 'nosniff',
	'x-frame-options': 'DENY',
	'referrer-policy': 'no-referrer',
	'strict-transport-security': 'max-age=31536000; includeSubDomains',
	'content-security-policy':
		// KHÔNG có `unsafe-eval`/`wasm-unsafe-eval`: client dùng PBKDF2 qua
		// WebCrypto (native) nên không cần compile WebAssembly.
		// `script-src` cho phép beacon của Cloudflare Web Analytics
		// (https://static.cloudflareinsights.com) — edge tự inject script này vào
		// HTML ⇒ nếu CSP không cho phép thì console báo CSP violation mỗi lần
		// tải trang. KHÔNG dùng 'unsafe-inline' cho script (chỉ style).
		"default-src 'self'; script-src 'self' https://static.cloudflareinsights.com; " +
		"style-src 'self' 'unsafe-inline'; " +
		"img-src 'self' data:; font-src 'self'; " +
		// `connect-src` cho phép host B2 (presigned PUT trực tiếp — đường fallback
		// của client) và host API. Đường chính vẫn là proxy qua API
		// (`POST /uploads/:id/content`) nên upload **không phụ thuộc** CSP này.
		// LƯU Ý: Cloudflare **edge** hiện **ghi đè** header CSP của Worker (đã kiểm
		// chứng 14/11/2026: sửa file này không làm header live thay đổi) ⇒ owner cần
		// sửa Transform Rule để giá trị dưới đây có hiệu lực trên zone.
		"connect-src 'self' https://api.alk.xx.kg https://s3.ca-east-006.backblazeb2.com; " +
		"object-src 'none'; base-uri 'none'; form-action 'self'; frame-ancestors 'none'",
	'permissions-policy': 'camera=(), microphone=(), geolocation=()',
	'cross-origin-opener-policy': 'same-origin',
};

export default {
	async fetch(request: Request, env: Env): Promise<Response> {
		const url = new URL(request.url);
		// Entry point → path có version ⇒ không dính cache/rule cũ ở edge
		// (xem header file). Edge có thể rewrite `/` thành `/index.html` trước khi
		// Worker chạy ⇒ kiểm tra cả hai.
		if (
			(url.pathname === '/' || url.pathname === '/index.html') &&
			(request.method === 'GET' || request.method === 'HEAD')
		) {
			const version = await getVersion(env);
			return new Response(null, {
				status: 307,
				headers: {
					location: `/app/${version}/`,
					'cache-control': 'no-store',
					'cdn-cache-control': 'no-store',
					'x-content-type-options': 'nosniff',
					'x-robots-tag': 'noindex, nofollow',
				},
			});
		}
		// `/api/*` KHÔNG thuộc web SPA. Nếu để SPA fallback phục vụ, client nhận
		// HTML 200 thay vì JSON ⇒ `response.json()` ném lỗi và mọi thao tác đăng
		// nhập/liệt kê file chết trong im lặng. Trả 404 JSON rõ ràng thay vì đoán.
		const response = url.pathname.startsWith('/api/')
			? new Response(
					JSON.stringify({
						error: { code: 'not_found', message: 'API không được phục vụ từ web domain' },
					}),
					{ status: 404, headers: { 'content-type': 'application/json; charset=utf-8' } },
				)
			: await env.ASSETS.fetch(request);
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
