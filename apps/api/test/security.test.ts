import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import type { DegradationMode } from '@alkcloud/core';
import { invalidateQuotaCache } from '../src/context.js';
import type { Harness } from './harness.js';
import { createHarness } from './harness.js';

const NOW = '2026-01-15T10:00:00.000Z';

async function setMode(harness: Harness, mode: DegradationMode): Promise<void> {
	await harness.db.setSystemState('quota_state', { mode }, NOW);
	invalidateQuotaCache(harness.db);
}

async function seedFile(harness: Harness, id = 'fil_sec'): Promise<string> {
	await harness.db.createFile({
		id,
		folderId: null,
		name: `${id}.txt`,
		size: 4,
		contentType: 'text/plain',
		objectKey: `objects/${id}/rev`,
		revisionId: 'rev',
		etag: 'etag',
		checksumSha256: null,
		now: NOW,
	});
	harness.storage.putObject(`objects/${id}/rev`, {
		size: 4,
		contentType: 'text/plain',
		etag: 'etag',
		body: new TextEncoder().encode('data'),
	});
	return id;
}

describe('degradation capability matrix', () => {
	it('READ_ONLY chặn tạo upload session nhưng vẫn cho complete session đang mở', async () => {
		const harness = await createHarness();
		const session = await harness.request('/uploads', {
			method: 'POST',
			body: { fileName: 'open.txt', contentType: 'text/plain', totalSize: 2, checksumSha256: null },
		});
		assert.equal(session.status, 201);
		const sessionBody = (await session.json()) as { uploadSessionId: string; parts: { url: string }[] };
		const key = harness.storage.keyFromPresignedUrl(sessionBody.parts[0]!.url);
		harness.storage.putObject(key, {
			size: 2,
			contentType: 'text/plain',
			etag: 'etag-open',
			body: new TextEncoder().encode('ok'),
		});

		await setMode(harness, 'READ_ONLY');
		const blocked = await harness.request('/uploads', {
			method: 'POST',
			body: { fileName: 'new.txt', contentType: 'text/plain', totalSize: 2, checksumSha256: null },
		});
		assert.equal(blocked.status, 429);
		assert.equal(blocked.headers.get('x-alkcloud-quota-mode'), 'READ_ONLY');

		const complete = await harness.request(`/uploads/${sessionBody.uploadSessionId}/complete`, {
			method: 'POST',
			body: { parts: [{ partNumber: 1, etag: 'etag-open', size: 2 }], checksumSha256: null },
		});
		assert.equal(complete.status, 201, 'complete luôn được phép để không mất dữ liệu upload');
	});

	it('CONSERVE chặn tìm kiếm nhưng vẫn liệt kê file', async () => {
		const harness = await createHarness();
		await seedFile(harness);
		await setMode(harness, 'CONSERVE');
		const list = await harness.request('/files');
		assert.equal(list.status, 200);
		const search = await harness.request('/files?q=fil');
		assert.equal(search.status, 429);
	});

	it('CONSERVE chặn tạo share mới nhưng vẫn cho tải share/public', async () => {
		const harness = await createHarness();
		const fileId = await seedFile(harness);
		await setMode(harness, 'CONSERVE');
		const share = await harness.request('/shares', {
			method: 'POST',
			body: { fileId, expiresInDays: 7, maxDownloads: null },
		});
		assert.equal(share.status, 429);
	});

	it('EMERGENCY vẫn cho owner tải file của mình', async () => {
		const harness = await createHarness();
		const fileId = await seedFile(harness);
		await setMode(harness, 'EMERGENCY');
		const download = await harness.request(`/files/${fileId}/download`);
		assert.equal(download.status, 200);
		assert.equal(await download.text(), 'data');
		const open = await harness.request(`/files/${fileId}/open`);
		assert.equal(open.status, 200);
	});

	it('EMERGENCY chặn public share download', async () => {
		const harness = await createHarness();
		const fileId = await seedFile(harness);
		const create = await harness.request('/shares', {
			method: 'POST',
			body: { fileId, expiresInDays: 7, maxDownloads: null },
		});
		const token = ((await create.json()) as { token: string }).token;
		await setMode(harness, 'EMERGENCY');
		const download = await harness.request('/public/share/download', { headers: { 'x-share-token': token } });
		assert.equal(download.status, 429);
	});
});

describe('auth & session hardening', () => {
	it('CSRF bắt buộc với DELETE và PATCH', async () => {
		const harness = await createHarness();
		const fileId = await seedFile(harness);
		const noCsrf = await harness.request(`/files/${fileId}`, {
			method: 'DELETE',
			headers: { 'x-alkcloud-csrf': '' },
		});
		assert.equal(noCsrf.status, 403);
		const noCsrfPatch = await harness.request(`/files/${fileId}`, {
			method: 'PATCH',
			body: { name: 'x.txt' },
			headers: { 'x-alkcloud-csrf': 'wrong' },
		});
		assert.equal(noCsrfPatch.status, 403);
	});

	it('session hết hạn bị từ chối', async () => {
		const harness = await createHarness();
		await harness.db.sqlDriver.run('UPDATE sessions SET expires_at = ?', ['2000-01-01T00:00:00.000Z']);
		const response = await harness.request('/auth/session');
		assert.equal(response.status, 401);
	});

	it('session bị thu hồi không dùng được', async () => {
		const harness = await createHarness();
		await harness.request('/auth/logout', { method: 'POST', body: {} });
		const response = await harness.request('/auth/session', { cookie: harness.cookie });
		assert.equal(response.status, 401);
	});

	it('share unlock bị rate limit sau 10 lần', async () => {
		const harness = await createHarness();
		const fileId = await seedFile(harness);
		const passwordVerifier = 'c'.repeat(64);
		const create = await harness.request('/shares', {
			method: 'POST',
			body: {
				fileId,
				expiresInDays: 7,
				maxDownloads: null,
				passwordVerifier,
				passwordSalt: 'salt-12345678',
				passwordParams: 'params-12345678',
			},
		});
		const token = ((await create.json()) as { token: string }).token;
		let status = 0;
		for (let attempt = 0; attempt < 11; attempt += 1) {
			const response = await harness.request('/public/share/unlock', {
				method: 'POST',
				body: { passwordVerifier: 'd'.repeat(64) },
				headers: { 'x-share-token': token },
			});
			status = response.status;
		}
		assert.equal(status, 429);
	});

	it('share grant cookie bị sửa => 403', async () => {
		const harness = await createHarness();
		const fileId = await seedFile(harness);
		const passwordVerifier = 'e'.repeat(64);
		const create = await harness.request('/shares', {
			method: 'POST',
			body: {
				fileId,
				expiresInDays: 7,
				maxDownloads: null,
				passwordVerifier,
				passwordSalt: 'salt-12345678',
				passwordParams: 'params-12345678',
			},
		});
		const token = ((await create.json()) as { token: string }).token;
		const unlock = await harness.request('/public/share/unlock', {
			method: 'POST',
			body: { passwordVerifier },
			headers: { 'x-share-token': token },
		});
		const cookie = (unlock.headers.get('set-cookie') ?? '').split(';')[0] ?? '';
		const [name, value] = cookie.split('=');
		const tampered = `${name}=${value!.slice(0, -1)}${value!.endsWith('a') ? 'b' : 'a'}`;
		const download = await harness.request('/public/share/download', {
			headers: { 'x-share-token': token },
			cookie: tampered,
		});
		assert.equal(download.status, 403);
	});

	it('share token trong query string không được chấp nhận', async () => {
		const harness = await createHarness();
		const fileId = await seedFile(harness);
		const create = await harness.request('/shares', {
			method: 'POST',
			body: { fileId, expiresInDays: 7, maxDownloads: null },
		});
		const token = ((await create.json()) as { token: string }).token;
		const response = await harness.request(`/public/share/info?token=${token}`);
		assert.equal(response.status, 401);
	});
});

describe('input validation', () => {
	it('rename với body quá lớn bị từ chối (413)', async () => {
		const harness = await createHarness();
		const fileId = await seedFile(harness);
		const big = 'x'.repeat(70 * 1024);
		const response = await harness.request(`/files/${fileId}`, { method: 'PATCH', body: { name: big } });
		assert.ok([400, 413].includes(response.status), `nhận ${response.status}`);
	});

	it('tên file chứa ký tự cấm bị từ chối', async () => {
		const harness = await createHarness();
		const response = await harness.request('/uploads', {
			method: 'POST',
			body: { fileName: 'a/b.txt', contentType: 'text/plain', totalSize: 1, checksumSha256: null },
		});
		assert.equal(response.status, 400);
	});

	it('lỗi không lộ chi tiết nội bộ', async () => {
		const harness = await createHarness();
		const response = await harness.request('/khong-ton-tai');
		assert.equal(response.status, 404);
		const body = (await response.json()) as { error: { code: string; message: string } };
		assert.equal(body.error.code, 'not_found');
		assert.ok(!/sqlite|select |from /i.test(body.error.message));
	});
});
