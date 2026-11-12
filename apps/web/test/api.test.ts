import assert from 'node:assert/strict';
import { afterEach, describe, it } from 'node:test';
import { ApiError, apiRequest, setCsrfToken } from '../src/lib/api.js';

/**
 * WS-I — kiểm thử API client.
 *
 * Bất biến quan trọng:
 *   - Mọi request **khác GET/HEAD** phải gửi header `x-alkcloud-csrf`.
 *   - Mọi request phải dùng `credentials: 'include'` (cookie phiên).
 *   - Lỗi HTTP phải chuyển thành `ApiError` kèm `code` từ body — UI hiển thị
 *     message tiếng Việt từ server, KHÔNG phải "HTTP 500" trống.
 *   - Response 204 phải trả `undefined` (không parse body rỗng).
 */

const originalFetch = globalThis.fetch;

afterEach(() => {
	globalThis.fetch = originalFetch;
	setCsrfToken(null);
});

interface Captured {
	url: string;
	init: RequestInit;
}

function stubFetch(response: Response): { calls: Captured[] } {
	const calls: Captured[] = [];
	globalThis.fetch = (async (url: string | URL, init: RequestInit = {}) => {
		calls.push({ url: String(url), init });
		// Clone: body của Response chỉ đọc được 1 lần ⇒ mỗi call cần bản sao.
		return response.clone();
	}) as typeof fetch;
	return { calls };
}

describe('WS-I — apiRequest', () => {
	it('gửi cookie phiên (credentials: include) cho mọi request', async () => {
		const { calls } = stubFetch(new Response('{}', { status: 200 }));
		await apiRequest('/files');
		assert.equal(calls[0]?.init.credentials, 'include');
	});

	it('gửi CSRF header cho method ghi, KHÔNG gửi cho GET/HEAD', async () => {
		const { calls } = stubFetch(new Response('{}', { status: 200 }));
		setCsrfToken('csrf-abc');
		await apiRequest('/files');
		assert.equal((calls[0]?.init.headers as Record<string, string>)['x-alkcloud-csrf'], undefined);

		await apiRequest('/folders', { method: 'POST', body: { name: 'x' } });
		assert.equal((calls[1]?.init.headers as Record<string, string>)['x-alkcloud-csrf'], 'csrf-abc');

		await apiRequest('/files/1', { method: 'DELETE' });
		assert.equal((calls[2]?.init.headers as Record<string, string>)['x-alkcloud-csrf'], 'csrf-abc');

		await apiRequest('/files/1', { method: 'HEAD' });
		assert.equal((calls[3]?.init.headers as Record<string, string>)['x-alkcloud-csrf'], undefined);
	});

	it('đặt content-type khi có body, bỏ qua khi body rỗng', async () => {
		const { calls } = stubFetch(new Response('{}', { status: 200 }));
		await apiRequest('/folders', { method: 'POST', body: { name: 'x' } });
		assert.equal((calls[0]?.init.headers as Record<string, string>)['content-type'], 'application/json');
		await apiRequest('/files');
		assert.equal((calls[1]?.init.headers as Record<string, string>)['content-type'], undefined);
	});

	it('chuyển lỗi HTTP thành ApiError kèm code và message từ server', async () => {
		stubFetch(
			new Response(JSON.stringify({ error: { code: 'quota_exceeded', message: 'Đã vượt quota lưu trữ' } }), {
				status: 429,
				headers: { 'content-type': 'application/json' },
			}),
		);
		await assert.rejects(
			() => apiRequest('/uploads', { method: 'POST', body: {} }),
			(error: unknown) => {
				assert.ok(error instanceof ApiError);
				assert.equal(error.status, 429);
				assert.equal(error.code, 'quota_exceeded');
				assert.equal(error.message, 'Đã vượt quota lưu trữ');
				return true;
			},
		);
	});

	it('lỗi không phải JSON ⇒ vẫn ném ApiError với code unknown', async () => {
		stubFetch(new Response('Gateway Timeout', { status: 504 }));
		await assert.rejects(
			() => apiRequest('/files'),
			(error: unknown) => {
				assert.ok(error instanceof ApiError);
				assert.equal(error.status, 504);
				assert.equal(error.code, 'unknown');
				return true;
			},
		);
	});

	it('response 204 ⇒ trả undefined (không parse body)', async () => {
		stubFetch(new Response(null, { status: 204 }));
		assert.equal(await apiRequest('/files/1', { method: 'DELETE' }), undefined);
	});

	it('trả payload đã parse cho response 200', async () => {
		stubFetch(
			new Response(JSON.stringify({ files: [{ id: 'f1' }] }), {
				status: 200,
				headers: { 'content-type': 'application/json' },
			}),
		);
		const result = await apiRequest<{ files: Array<{ id: string }> }>('/files');
		assert.equal(result.files[0]?.id, 'f1');
	});

	it('truyền AbortSignal xuống fetch (hủy upload khi người dùng đổi ý)', async () => {
		const { calls } = stubFetch(new Response('{}', { status: 200 }));
		const controller = new AbortController();
		await apiRequest('/files', { signal: controller.signal });
		assert.equal(calls[0]?.init.signal, controller.signal);
	});
});
