import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { createHarness } from './harness.js';

const BODY = new TextEncoder().encode('0123456789abcdef');

async function seed(harness: Awaited<ReturnType<typeof createHarness>>): Promise<string> {
	await harness.db.createFile({
		id: 'fil_dl',
		folderId: null,
		name: 'tài liệu (1).txt',
		size: BODY.length,
		contentType: 'text/plain; charset=utf-8',
		objectKey: 'objects/fil_dl/rev',
		revisionId: 'rev',
		etag: 'etag-dl',
		checksumSha256: null,
		now: '2026-01-15T10:00:00.000Z',
	});
	harness.storage.putObject('objects/fil_dl/rev', {
		size: BODY.length,
		contentType: 'text/plain; charset=utf-8',
		etag: 'etag-dl',
		body: BODY,
	});
	return 'fil_dl';
}

describe('download & range', () => {
	it('trả 302 tới presigned GET của B2 — KHÔNG stream byte qua Worker', async () => {
		const harness = await createHarness();
		const fileId = await seed(harness);
		const response = await harness.request(`/files/${fileId}/download`, { followPresign: false });
		assert.equal(response.status, 302);
		assert.equal(await response.text(), '', 'response redirect không được chứa byte file');
		const location = response.headers.get('location') ?? '';
		assert.match(location, /^https:\/\/mock\.invalid\/get\//);
		assert.match(location, /response-content-disposition=attachment/);
		assert.equal(response.headers.get('cache-control'), 'private, no-store');
	});

	it('tải toàn bộ: content-type, content-disposition UTF-8, accept-ranges', async () => {
		const harness = await createHarness();
		const fileId = await seed(harness);
		const response = await harness.request(`/files/${fileId}/download`);
		assert.equal(response.status, 200);
		assert.equal(response.headers.get('content-type'), 'text/plain; charset=utf-8');
		assert.equal(response.headers.get('accept-ranges'), 'bytes');
		assert.equal(response.headers.get('cache-control'), 'private, no-store');
		assert.match(response.headers.get('content-disposition') ?? '', /filename\*=UTF-8''/);
		assert.equal(await response.text(), '0123456789abcdef');
	});

	it('Range trả 206 + content-range đúng', async () => {
		const harness = await createHarness();
		const fileId = await seed(harness);
		const response = await harness.request(`/files/${fileId}/download`, { headers: { range: 'bytes=2-5' } });
		assert.equal(response.status, 206);
		assert.equal(response.headers.get('content-range'), `bytes 2-5/${BODY.length}`);
		assert.equal(response.headers.get('content-length'), '4');
		assert.equal(await response.text(), '2345');
	});

	it('Range suffix (bytes=-4) trả 4 byte cuối', async () => {
		const harness = await createHarness();
		const fileId = await seed(harness);
		const response = await harness.request(`/files/${fileId}/download`, { headers: { range: 'bytes=-4' } });
		assert.equal(response.status, 206);
		assert.equal(await response.text(), 'cdef');
	});

	it('Range ngoài phạm vi trả 416', async () => {
		const harness = await createHarness();
		const fileId = await seed(harness);
		const response = await harness.request(`/files/${fileId}/download`, { headers: { range: 'bytes=999-' } });
		assert.equal(response.status, 416);
	});

	it('file đã xoá mềm không tải được', async () => {
		const harness = await createHarness();
		const fileId = await seed(harness);
		await harness.request(`/files/${fileId}`, { method: 'DELETE' });
		const response = await harness.request(`/files/${fileId}/download`);
		assert.equal(response.status, 404);
	});

	it('/open trả presigned URL + metadata, TTL 5 phút', async () => {
		const harness = await createHarness();
		const fileId = await seed(harness);
		const response = await harness.request(`/files/${fileId}/open`);
		assert.equal(response.status, 200);
		const body = (await response.json()) as {
			url: string;
			expiresAt: string;
			contentType: string;
			name: string;
			size: number;
		};
		assert.match(body.url, /^https:\/\/mock\.invalid\/get\//);
		assert.equal(body.name, 'tài liệu (1).txt');
		assert.equal(body.size, BODY.length);
		const ttlMs = new Date(body.expiresAt).getTime() - Date.now();
		assert.ok(ttlMs > 290_000 && ttlMs <= 300_000, `TTL phải ~300s, nhận ${ttlMs}`);
	});
});
