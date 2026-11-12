import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { describe, it } from 'node:test';
import { B2Storage } from '@alkcloud/storage';

/**
 * Integration test với Backblaze B2 THẬT.
 *
 * Chỉ chạy khi có đủ biến môi trường:
 *   ALKCLOUD_TEST_B2_ENDPOINT   vd https://s3.us-west-004.backblazeb2.com
 *   ALKCLOUD_TEST_B2_REGION     vd us-west-004
 *   ALKCLOUD_TEST_B2_BUCKET
 *   ALKCLOUD_TEST_B2_KEY_ID
 *   ALKCLOUD_TEST_B2_APP_KEY
 *
 * Không có creds ⇒ SKIP rõ ràng (không giả lập PASS).
 * Chạy: npm run test:integration
 */

const endpoint = process.env.ALKCLOUD_TEST_B2_ENDPOINT;
const region = process.env.ALKCLOUD_TEST_B2_REGION;
const bucket = process.env.ALKCLOUD_TEST_B2_BUCKET;
const keyId = process.env.ALKCLOUD_TEST_B2_KEY_ID;
const appKey = process.env.ALKCLOUD_TEST_B2_APP_KEY;

const configured = Boolean(endpoint && region && bucket && keyId && appKey);
const skipReason = configured
	? false
	: 'SKIP: thiếu ALKCLOUD_TEST_B2_* (B2 chưa cấu hình — blocker B3)';

function makeStorage(): B2Storage {
	return new B2Storage({
		endpoint: endpoint!,
		region: region!,
		bucket: bucket!,
		accessKeyId: keyId!,
		secretAccessKey: appKey!,
	});
}

const prefix = `alkcloud-selftest/${Date.now()}-${randomBytes(4).toString('hex')}`;

describe('B2 integration (real bucket)', { skip: skipReason }, () => {
	it('presigned PUT + GET round-trip', async () => {
		const storage = makeStorage();
		const body = randomBytes(2048);
		const key = `${prefix}/single.bin`;
		const target = await storage.presignPut({ key, contentType: 'application/octet-stream', expiresInSeconds: 300 });
		const put = await fetch(target.url, {
			method: 'PUT',
			headers: { 'content-type': 'application/octet-stream' },
			body,
		});
		assert.equal(put.status, 200, `PUT thất bại: ${put.status} ${await put.text()}`);

		const stat = await storage.headObject(key);
		assert.equal(stat?.size, body.length);

		const get = await storage.presignGet({ key, expiresInSeconds: 300 });
		const downloaded = await fetch(get.url);
		assert.equal(downloaded.status, 200);
		const bytes = new Uint8Array(await downloaded.arrayBuffer());
		assert.deepEqual(Buffer.from(bytes), body);

		const versions = await storage.listObjectVersions(key);
		for (const version of versions) await storage.deleteObjectVersion(key, version.versionId);
		if (versions.length === 0) await storage.deleteObject(key);
	});

	it('multipart: create → presign parts → list → complete → head', async () => {
		const storage = makeStorage();
		const partSize = 5 * 1024 * 1024;
		const key = `${prefix}/multipart.bin`;
		const { uploadId } = await storage.createMultipartUpload({ key, contentType: 'application/octet-stream' });
		assert.ok(uploadId);

		const parts: { partNumber: number; size: number }[] = [];
		for (const partNumber of [1, 2]) {
			const target = await storage.presignUploadPart({ key, uploadId, partNumber, expiresInSeconds: 600 });
			const body = randomBytes(partNumber === 2 ? 1024 : partSize);
			const put = await fetch(target.url, { method: 'PUT', body });
			assert.equal(put.status, 200, `PUT part ${partNumber} thất bại: ${put.status}`);
			parts.push({ partNumber, size: body.length });
		}

		const remote = await storage.listParts({ key, uploadId });
		assert.equal(remote.length, 2);
		const completed = await storage.completeMultipartUpload({
			key,
			uploadId,
			parts: remote,
		});
		assert.ok(completed.etag ?? true);
		const stat = await storage.headObject(key);
		assert.equal(stat?.size, partSize + 1024);

		const versions = await storage.listObjectVersions(key);
		for (const version of versions) await storage.deleteObjectVersion(key, version.versionId);
		if (versions.length === 0) await storage.deleteObject(key);
	});
});
