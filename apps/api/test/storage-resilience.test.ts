import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { StorageError } from '@alkcloud/storage';
import { createHarness } from './harness.js';

/**
 * WS-B — hành vi API khi lớp lưu trữ lỗi.
 *
 * Yêu cầu sản phẩm: lỗi hạ tầng phải trả mã chuẩn (503 + `Retry-After`) để
 * client biết thử lại, KHÔNG trả 500 "lỗi nội bộ" và KHÔNG lộ chi tiết B2.
 */

describe('WS-B — lỗi storage trả mã chuẩn', () => {
	it('StorageError 503 ⇒ 503 storage_unavailable + Retry-After, không lộ message gốc', async () => {
		const harness = await createHarness();
		harness.storage.failWith(new StorageError('B2 endpoint https://s3.internal.example lỗi', 503));

		const response = await harness.request('/uploads', {
			method: 'POST',
			body: { fileName: 'x.txt', contentType: 'text/plain', totalSize: 5, checksumSha256: null },
		});
		assert.equal(response.status, 503);
		const body = (await response.json()) as { error: { code: string; message: string } };
		assert.equal(body.error.code, 'storage_unavailable');
		assert.equal(body.error.message, 'Dịch vụ lưu trữ tạm thời không khả dụng');
		assert.ok(!JSON.stringify(body).includes('internal.example'), 'KHÔNG lộ endpoint B2');
		assert.equal(response.headers.get('retry-after'), '5');
	});

	it('StorageError 404 ⇒ cũng là 503 (lỗi hạ tầng, không phải lỗi client)', async () => {
		const harness = await createHarness();
		harness.storage.failWith(new StorageError('no such object', 404));
		const response = await harness.request('/uploads', {
			method: 'POST',
			body: { fileName: 'x.txt', contentType: 'text/plain', totalSize: 5, checksumSha256: null },
		});
		assert.equal(response.status, 503);
	});

	it('lỗi storage KHÔNG được tính là "upload hoàn tất"', async () => {
		const harness = await createHarness();
		harness.storage.failWith(new StorageError('boom', 503));
		const response = await harness.request('/uploads', {
			method: 'POST',
			body: { fileName: 'x.txt', contentType: 'text/plain', totalSize: 5, checksumSha256: null },
		});
		assert.notEqual(response.status, 201);
		// Không có file nào được tạo trong DB.
		const files = (await (await harness.request('/files')).json()) as { files: unknown[] };
		assert.equal(files.files.length, 0);
	});
});
