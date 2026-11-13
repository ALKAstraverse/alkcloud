/**
 * `alkcloud-b2relay` — hop công khai duy nhất tới Backblaze B2.
 *
 * LÝ DO TỒN TẠI (đo thật 13/11/2026):
 *   Worker gắn route trong zone `alk.xx.kg` gọi `fetch()` tới
 *   `s3.ca-east-006.backblazeb2.com` nhận **HTTP 525** (SSL handshake failed),
 *   trong khi cùng đoạn code chạy trên `*.workers.dev` trả 404/200 bình thường.
 *   Service binding cũng dính 525 ⇒ bắt buộc 2 hop công khai, đúng pattern đã
 *   dùng cho `cf-api-gateway` (`cloudflared/rule.md`).
 *
 * Mô hình: API Worker giữ chữ ký SigV4 của B2, gửi nguyên request + header chữ ký
 * tới relay này; relay chỉ kiểm tra đích + token rồi chuyển tiếp. Chữ ký vẫn hợp
 * lệ vì `host`, path và query không đổi.
 *
 * BẢO MẬT:
 *   - Chỉ nhận đích `https:` đúng `B2_ALLOWED_HOST` (chống open proxy/SSRF).
 *   - Bắt buộc header `x-alkcloud-relay-token` khớp secret (so sánh hằng thời gian).
 *   - Không log URL đã ký / header Authorization.
 *   - `redirect: "manual"` để client tự xử lý 3xx của S3, relay không đi theo.
 */

export interface RelayEnv {
	B2_ALLOWED_HOST: string;
	B2_RELAY_TOKEN: string;
}

export const TARGET_HEADER = 'x-alkcloud-target';
export const TOKEN_HEADER = 'x-alkcloud-relay-token';

const JSON_HEADERS = {
	'content-type': 'application/json; charset=utf-8',
	'cache-control': 'no-store',
};

function json(body: unknown, status: number): Response {
	return new Response(JSON.stringify(body), { status, headers: JSON_HEADERS });
}

/** So sánh hằng thời gian — tránh rò rỉ tiền tố token qua thời gian phản hồi. */
export function constantTimeEqual(left: string, right: string): boolean {
	const a = new TextEncoder().encode(left);
	const b = new TextEncoder().encode(right);
	let diff = a.length ^ b.length;
	const max = Math.max(a.length, b.length);
	for (let index = 0; index < max; index += 1) {
		diff |= (a[index] ?? 0) ^ (b[index] ?? 0);
	}
	return diff === 0;
}

/** Chỉ chấp nhận HTTPS + đúng host B2 đã cấu hình. Trả `null` nếu không hợp lệ. */
export function resolveTarget(raw: string | null, allowedHost: string): URL | null {
	if (!raw || !allowedHost) return null;
	let url: URL;
	try {
		url = new URL(raw);
	} catch {
		return null;
	}
	if (url.protocol !== 'https:') return null;
	if (url.host !== allowedHost) return null;
	if (url.username || url.password) return null;
	return url;
}

/**
 * Chuyển tiếp request tới B2. `fetchImpl` được inject để unit test không gọi mạng.
 */
export async function handleRelay(
	request: Request,
	env: RelayEnv,
	fetchImpl: (input: string, init: RequestInit) => Promise<Response> = fetch,
): Promise<Response> {
	const url = new URL(request.url);
	if (url.pathname === '/health') {
		return json({ status: 'ok', service: 'alkcloud-b2relay' }, 200);
	}
	if (!env.B2_RELAY_TOKEN || !constantTimeEqual(request.headers.get(TOKEN_HEADER) ?? '', env.B2_RELAY_TOKEN)) {
		return json({ error: 'unauthorized' }, 401);
	}
	const target = resolveTarget(request.headers.get(TARGET_HEADER), env.B2_ALLOWED_HOST);
	if (!target) return json({ error: 'bad_target' }, 400);

	const headers = new Headers();
	request.headers.forEach((value, key) => {
		if (key === TARGET_HEADER || key === TOKEN_HEADER) return;
		headers.set(key, value);
	});
	// Chữ ký SigV4 của B2 ký `host` — phải khớp host đích, không phải host relay.
	headers.set('host', target.host);

	const method = request.method.toUpperCase();
	const hasBody = method !== 'GET' && method !== 'HEAD';
	const upstream = await fetchImpl(target.toString(), {
		method,
		headers,
		...(hasBody && request.body ? { body: request.body, duplex: 'half' } : {}),
		redirect: 'manual',
	} as RequestInit);

	const responseHeaders = new Headers(upstream.headers);
	const noBody = method === 'HEAD' || upstream.status === 204 || upstream.status === 304;
	return new Response(noBody ? null : upstream.body, {
		status: upstream.status,
		statusText: upstream.statusText,
		headers: responseHeaders,
	});
}

export default {
	fetch(request: Request, env: RelayEnv): Promise<Response> {
		return handleRelay(request, env);
	},
};
