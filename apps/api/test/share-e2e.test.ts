import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import type { Harness } from './harness.js';
import { createHarness } from './harness.js';

const NOW = '2026-01-15T10:00:00.000Z';

async function seed(harness: Harness, id = 'fil_share'): Promise<string> {
	await harness.db.createFile({
		id,
		folderId: null,
		name: 'share.txt',
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

async function createShare(harness: Harness, fileId: string, extra: Record<string, unknown> = {}) {
	const response = await harness.request('/shares', {
		method: 'POST',
		body: { fileId, expiresInDays: 7, maxDownloads: null, ...extra },
	});
	assert.equal(response.status, 201, `tạo share phải 201, nhận ${response.status}`);
	return (await response.json()) as { share: { id: string }; token: string };
}

describe('share E2E', () => {
	it('share hết hạn => 404 (info + download)', async () => {
		const harness = await createHarness();
		const fileId = await seed(harness);
		const share = await createShare(harness, fileId);
		await harness.db.sqlDriver.run('UPDATE shares SET expires_at = ?', ['2000-01-01T00:00:00.000Z']);
		assert.equal((await harness.request('/public/share/info', { headers: { 'x-share-token': share.token } })).status, 404);
		assert.equal(
			(await harness.request('/public/share/download', { headers: { 'x-share-token': share.token } })).status,
			404,
		);
	});

	it('share của file đã xoá mềm => 404', async () => {
		const harness = await createHarness();
		const fileId = await seed(harness);
		const share = await createShare(harness, fileId);
		await harness.request(`/files/${fileId}`, { method: 'DELETE' });
		assert.equal((await harness.request('/public/share/info', { headers: { 'x-share-token': share.token } })).status, 404);
	});

	it('tạo share cho file không tồn tại => 404', async () => {
		const harness = await createHarness();
		const response = await harness.request('/shares', {
			method: 'POST',
			body: { fileId: 'fil_khong_co', expiresInDays: 7, maxDownloads: null },
		});
		assert.equal(response.status, 404);
	});

	it('list share theo file; revoke hiện revokedAt', async () => {
		const harness = await createHarness();
		const fileId = await seed(harness);
		const share = await createShare(harness, fileId);
		const list = await harness.request(`/shares?fileId=${fileId}`);
		const listBody = (await list.json()) as { shares: { id: string; revokedAt: string | null; hasPassword: boolean }[] };
		assert.equal(listBody.shares.length, 1);
		assert.equal(listBody.shares[0]?.revokedAt, null);
		assert.equal(listBody.shares[0]?.hasPassword, false);

		await harness.request(`/shares/${share.share.id}`, { method: 'DELETE' });
		const after = await harness.request(`/shares?fileId=${fileId}`);
		const afterBody = (await after.json()) as { shares: { revokedAt: string | null }[] };
		assert.notEqual(afterBody.shares[0]?.revokedAt, null);
	});

	it('update maxDownloads được áp dụng ngay', async () => {
		const harness = await createHarness();
		const fileId = await seed(harness);
		const share = await createShare(harness, fileId);
		const update = await harness.request(`/shares/${share.share.id}`, {
			method: 'PATCH',
			body: { maxDownloads: 1 },
		});
		assert.equal(update.status, 200);
		const first = await harness.request('/public/share/download', { headers: { 'x-share-token': share.token } });
		assert.equal(first.status, 200);
		const second = await harness.request('/public/share/download', { headers: { 'x-share-token': share.token } });
		assert.equal(second.status, 403);
	});

	it('expiresInDays ngoài khoảng 1..90 => 400', async () => {
		const harness = await createHarness();
		const fileId = await seed(harness);
		for (const expiresInDays of [0, 91, -5]) {
			const response = await harness.request('/shares', {
				method: 'POST',
				body: { fileId, expiresInDays, maxDownloads: null },
			});
			assert.equal(response.status, 400, `expiresInDays=${expiresInDays} phải 400`);
		}
	});

	it('unlock sai mật khẩu => 403 và ghi audit', async () => {
		const harness = await createHarness();
		const fileId = await seed(harness);
		const passwordVerifier = 'f'.repeat(64);
		const share = await createShare(harness, fileId, {
			passwordVerifier,
			passwordSalt: 'salt-12345678',
			passwordParams: 'params-12345678',
		});
		const wrong = await harness.request('/public/share/unlock', {
			method: 'POST',
			body: { passwordVerifier: 'a'.repeat(64) },
			headers: { 'x-share-token': share.token },
		});
		assert.equal(wrong.status, 403);
		const audit = await harness.db.listAudit(20);
		assert.ok(audit.some((event) => event.action === 'share.unlock.failure'));
	});

	it('unlock trả grant trong body; download + info nhận qua header x-share-grant', async () => {
		const harness = await createHarness();
		const fileId = await seed(harness);
		const passwordVerifier = 'b'.repeat(64);
		const share = await createShare(harness, fileId, {
			passwordVerifier,
			passwordSalt: 'salt-12345678',
			passwordParams: 'params-12345678',
		});
		const unlock = await harness.request('/public/share/unlock', {
			method: 'POST',
			body: { passwordVerifier },
			headers: { 'x-share-token': share.token },
		});
		assert.equal(unlock.status, 200);
		const unlockBody = (await unlock.json()) as { grant: string };
		assert.ok(unlockBody.grant.includes('.'));

		// Không cần cookie: header grant đủ để tải (cross-site flow).
		const download = await harness.request('/public/share/download', {
			headers: { 'x-share-token': share.token, 'x-share-grant': unlockBody.grant },
			cookie: '',
		});
		assert.equal(download.status, 200);
		assert.equal(await download.text(), 'data');

		const info = await harness.request('/public/share/info', {
			headers: { 'x-share-token': share.token, 'x-share-grant': unlockBody.grant },
			cookie: '',
		});
		const infoBody = (await info.json()) as { share: { fileName: string | null; unlocked: boolean } };
		assert.equal(infoBody.share.unlocked, true);
		assert.equal(infoBody.share.fileName, 'share.txt');

		const tampered = await harness.request('/public/share/download', {
			headers: { 'x-share-token': share.token, 'x-share-grant': `${unlockBody.grant}x` },
			cookie: '',
		});
		assert.equal(tampered.status, 403);
	});

	it('token trong fragment không gửi lên server (URL trả về dùng #)', async () => {
		const harness = await createHarness();
		const fileId = await seed(harness);
		const share = await createShare(harness, fileId);
		const create = await harness.request('/shares', {
			method: 'POST',
			body: { fileId, expiresInDays: 1, maxDownloads: null },
		});
		const body = (await create.json()) as { url: string; token: string };
		assert.ok(body.url.endsWith(`/s#${body.token}`));
		assert.ok(!body.url.includes(share.token));
	});
});
