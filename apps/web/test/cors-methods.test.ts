import assert from 'node:assert/strict';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, it } from 'node:test';

/**
 * WS-K — bất biến CORS: method của web client phải nằm trong allow-list **thực thi**.
 *
 * Sự cố đã gặp (14/11/2026): client dùng `PUT` để upload. Cloudflare **edge**
 * trả `Access-Control-Allow-Methods: GET, POST, PATCH, DELETE, OPTIONS` (không có
 * `PUT`) ⇒ Chrome **chặn request thật ngay sau preflight** ⇒ preflight trả 204 OK
 * nhưng browser **không gửi** request ⇒ "Failed to fetch".
 *
 * Vì sao test này cần thiết:
 *   - `curl` và `node fetch` **không** thực thi CORS ⇒ kiểm thử bằng chúng cho kết quả
 *     "thành công" giả ⇒ dễ bỏ sót.
 *   - allow-list do **edge** quyết định, không nằm trong mã nguồn ⇒ phải chốt lại
 *     bằng hằng số đo live từ `curl -I`.
 */

/** Allow-list **thực thi** ở Cloudflare edge (đo live 14/11/2026, zone alk.xx.kg). */
const EDGE_ALLOWED_METHODS = ['GET', 'POST', 'PATCH', 'DELETE', 'OPTIONS'];

/** Allow-list mà API Worker khai báo trong `app.options('*')`. */
const APP_ALLOWED_METHODS = ['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS'];

const here = fileURLToPath(new URL('.', import.meta.url));
const webSrc = join(here, '..', 'src');
const apiApp = join(here, '..', '..', 'api', 'src', 'app.ts');

/**
 * Chỉ các request gọi tới **API** mới bị giới hạn bởi allow-list của edge.
 * Request PUT thẳng vào presigned URL của B2 dùng CORS **của bucket** (B2 cho
 * phép PUT) và bị chặn bởi CSP `connect-src` — không thuộc phạm vi test này.
 */
function isApiCall(source: string, index: number): boolean {
	const before = source.slice(Math.max(0, index - 600), index);
	const lastFetch = before.lastIndexOf('fetch(');
	if (lastFetch === -1) return false;
	const call = before.slice(lastFetch);
	return call.includes('API_BASE');
}

function walk(dir: string): string[] {
	const out: string[] = [];
	for (const entry of readdirSync(dir)) {
		const full = join(dir, entry);
		if (statSync(full).isDirectory()) out.push(...walk(full));
		else if (/\.(ts|tsx)$/.test(entry)) out.push(full);
	}
	return out;
}

describe('WS-K — CORS method allow-list', () => {
	it('allow-list của edge chứa mọi method mà web client dùng', () => {
		const used = new Map<string, string>();
		for (const file of walk(webSrc)) {
			const source = readFileSync(file, 'utf8');
			for (const match of source.matchAll(/method:\s*'([A-Z]+)'/g)) {
				const method = match[1]!;
				if (!isApiCall(source, match.index ?? 0)) continue;
				if (!used.has(method)) used.set(method, file.replace(here, ''));
			}
		}
		for (const [method, file] of used) {
			assert.ok(
				EDGE_ALLOWED_METHODS.includes(method),
				`web client dùng "${method}" (${file}) nhưng Cloudflare edge KHÔNG cho phép ` +
					`(${EDGE_ALLOWED_METHODS.join(', ')}) ⇒ Chrome sẽ chặn request sau preflight. ` +
					`Hãy dùng method khác (POST an toàn) hoặc đổi rule ở edge.`,
			);
		}
	});

	it('allow-list của API Worker chứa mọi method mà web client dùng', () => {
		const source = readFileSync(apiApp, 'utf8');
		const match = source.match(/'access-control-allow-methods':\s*'([^']+)'/);
		assert.ok(match, 'phải tìm thấy access-control-allow-methods trong apps/api/src/app.ts');
		const allowed = match[1]!.split(',').map((value) => value.trim());
		for (const method of allowed) {
			assert.ok(APP_ALLOWED_METHODS.includes(method), `allow-list Worker chứa method lạ: ${method}`);
		}
		const used = new Set<string>();
		for (const file of walk(webSrc)) {
			const source = readFileSync(file, 'utf8');
			for (const found of source.matchAll(/method:\s*'([A-Z]+)'/g)) {
				if (!isApiCall(source, found.index ?? 0)) continue;
				used.add(found[1]!);
			}
		}
		for (const method of used) {
			assert.ok(allowed.includes(method), `web client dùng "${method}" nhưng Worker không cho phép`);
		}
	});

	it('edge không cho phép PUT ⇒ client không được dùng PUT', () => {
		// Chốt rõ ràng để lần refactor sau không vô tình dùng lại PUT.
		assert.equal(EDGE_ALLOWED_METHODS.includes('PUT'), false);
	});
});
