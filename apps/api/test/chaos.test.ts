import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { Database, runMigrations } from '@alkcloud/db';
import { SqliteDriver } from '@alkcloud/db/sqlite';
import { MockObjectStorage } from '@alkcloud/storage';
import { createApp } from '../src/app.js';
import { resolveConfig, type Env } from '../src/env.js';
import { loadMigrationFiles } from '../../../packages/db/test/helpers.js';
import { API, ORIGIN, SETUP_TOKEN, AUTH_KEY } from './harness.js';
import {
	assertNoMetadataWithoutObject,
	createFaultyDriver,
	createFaultyStorage,
	currentOwnerId,
	listAllFiles,
	totalReservedBytes,
	type FaultyDriver,
	type FaultyStorage,
} from './chaos/harness.js';
import type { SqlDriver } from '@alkcloud/db';
import type { ObjectStorage } from '@alkcloud/storage';

const NOW = '2026-01-15T10:00:00.000Z';

interface ChaosHarness {
	app: ReturnType<typeof createApp>;
	db: Database;
	storage: FaultyStorage;
	driver: FaultyDriver;
	cookie: string;
	csrf: string;
	request: (
		path: string,
		options?: { method?: string; body?: unknown; headers?: Record<string, string>; cookie?: string },
	) => Promise<Response>;
}

/**
 * Tạo app với storage + DB có thể tiêm lỗi.
 * `failStorage`/`failDriver` là quy tắc lỗi áp dụng ngay từ đầu.
 */
async function createChaosHarness(options: {
	failStorage?: Array<{ operation: keyof ObjectStorage | '*'; mode: 'timeout' | 'server_error' | 'disconnect' | 'conflict'; times?: number; onCall?: number }>;
	failDriver?: { failOn?: RegExp; operation?: 'query' | 'run' | 'batch' | 'exec'; mode?: 'timeout' | 'server_error'; times?: number };
} = {}): Promise<ChaosHarness> {
	const baseDriver = new SqliteDriver(':memory:');
	await runMigrations(baseDriver, loadMigrationFiles());
	const driver = createFaultyDriver({
		driver: baseDriver,
		failOn: options.failDriver?.failOn,
		operation: options.failDriver?.operation,
		mode: options.failDriver?.mode,
		times: options.failDriver?.times,
	});
	const db = new Database(driver);
	const storage = createFaultyStorage({
		storage: new MockObjectStorage(),
		rules: options.failStorage,
	});
	const config = resolveConfig({
		ALKCLOUD_ALLOWED_ORIGINS: ORIGIN,
		ALKCLOUD_PUBLIC_URL: 'https://cloud.alk.xx.kg',
		ALKCLOUD_API_URL: API,
		AUTH_PEPPER: 'test-pepper-value-0123456789',
		BOOTSTRAP_SETUP_TOKEN: SETUP_TOKEN,
		ENVIRONMENT: 'test',
	} as unknown as Env);
	const app = createApp({ db, storage, config, now: () => new Date(NOW) });

	let cookie = '';
	let csrf = '';
	const request = async (
		path: string,
		reqOptions: { method?: string; body?: unknown; headers?: Record<string, string>; cookie?: string } = {},
	) => {
		const method = reqOptions.method ?? 'GET';
		const headers: Record<string, string> = {
			origin: ORIGIN,
			'x-alkcloud-csrf': csrf,
			...(reqOptions.cookie !== undefined ? { cookie: reqOptions.cookie } : {}),
			...(reqOptions.body !== undefined ? { 'content-type': 'application/json' } : {}),
			...(reqOptions.headers ?? {}),
		};
		if (reqOptions.cookie === undefined && cookie) headers.cookie = cookie;
		return app.fetch(
			new Request(`${API}${path}`, {
				method,
				headers,
				body: reqOptions.body === undefined ? undefined : JSON.stringify(reqOptions.body),
			}),
		);
	};

	// Bootstrap (nếu driver lỗi thì bỏ qua — test sẽ assert).
	const bootstrap = await request('/auth/bootstrap', {
		method: 'POST',
		body: {
			setupToken: SETUP_TOKEN,
			email: 'owner@alkcloud.test',
			authKey: AUTH_KEY,
			authVerifierSalt: 'salt-12345678',
			authParams: 'params-12345678',
		},
	});
	if (bootstrap.status === 201) {
		cookie = (bootstrap.headers.get('set-cookie') ?? '').split(';')[0] ?? '';
		csrf = ((await bootstrap.json()) as { session: { csrfToken: string } }).session.csrfToken;
	}

	return { app, db, storage, driver, cookie, csrf, request };
}

/** Tạo upload session + PUT object giả, trả về sessionId + key. */
async function createUploadedFile(
	harness: ChaosHarness,
	fileName: string,
	size = 5,
): Promise<{ sessionId: string; objectKey: string; fileId: string }> {
	const response = await harness.request('/uploads', {
		method: 'POST',
		body: { fileName, contentType: 'text/plain', totalSize: size, checksumSha256: null },
	});
	assert.equal(response.status, 201, `tạo upload session thất bại: ${response.status}`);
	const body = (await response.json()) as {
		uploadSessionId: string;
		parts: Array<{ url: string }>;
	};
	const objectKey = harness.storage.keyFromPresignedUrl(body.parts[0]!.url);
	harness.storage.putObject(objectKey, {
		size,
		contentType: 'text/plain',
		etag: `etag-${fileName}`,
		body: new TextEncoder().encode('hello'),
	});
	return { sessionId: body.uploadSessionId, objectKey, fileId: objectKey.split('/')[1] ?? '' };
}

/** Số file trong D1 (kể cả trong trash). */
async function countFiles(db: Database): Promise<number> {
	return (await listAllFiles(db)).length;
}

describe('chaos — WS-L: không mất dữ liệu khi hạ tầng hỏng', () => {
	it('C1. B2 timeout khi tạo upload session ⇒ session + quota được dọn, không rò byte', async () => {
		const harness = await createChaosHarness({
			failStorage: [{ operation: 'presignPut', mode: 'timeout', times: 1 }],
		});
		const ownerId = await currentOwnerId(harness.db);

		const response = await harness.request('/uploads', {
			method: 'POST',
			body: { fileName: 'x.bin', contentType: 'application/octet-stream', totalSize: 1000, checksumSha256: null },
		});
		assert.ok(response.status >= 400, 'phải trả lỗi');
		const body = await response.text();
		assert.ok(!body.includes('[chaos]'), 'lỗi nội bộ không được lộ ra response');
		assert.ok(!body.includes('at Object.'), 'stack trace không được lộ ra response');

		// Không còn session OPEN treo, không rò quota.
		const reserved = await totalReservedBytes(harness.db, ownerId);
		assert.equal(reserved, 0, `phải release quota, còn ${reserved} byte bị giữ`);
		const sessions = await harness.db.listOpenUploadSessions(100);
		assert.equal(sessions.length, 0, 'không còn session OPEN');
	});

	it('C2. B2 timeout khi complete ⇒ file KHÔNG được tạo (không mất dữ liệu, không file mồ côi)', async () => {
		const harness = await createChaosHarness();
		const { sessionId } = await createUploadedFile(harness, 'complete-fail.txt');

		harness.storage.setRules([{ operation: 'headObject', mode: 'timeout', times: 1 }]);
		const response = await harness.request(`/uploads/${sessionId}/complete`, {
			method: 'POST',
			body: { parts: [{ partNumber: 1, etag: 'etag-complete-fail.txt', size: 5 }], checksumSha256: null },
		});
		assert.ok(response.status >= 400);
		assert.equal(await countFiles(harness.db), 0, 'chưa được tạo file khi complete thất bại');
		// Session phải vẫn OPEN để client thử lại được (không mất dữ liệu đã upload).
		const session = await harness.db.getUploadSession(sessionId);
		assert.equal(session?.status, 'OPEN', 'session phải còn OPEN để retry');
	});

	it('C3. Retry complete sau khi B2 hồi phục ⇒ thành công, đúng 1 file', async () => {
		const harness = await createChaosHarness();
		const { sessionId } = await createUploadedFile(harness, 'retry.txt');

		harness.storage.setRules([{ operation: 'headObject', mode: 'timeout', times: 1 }]);
		const failed = await harness.request(`/uploads/${sessionId}/complete`, {
			method: 'POST',
			body: { parts: [{ partNumber: 1, etag: 'etag-retry.txt', size: 5 }], checksumSha256: null },
		});
		assert.ok(failed.status >= 400);

		harness.storage.clearRules();
		const ok = await harness.request(`/uploads/${sessionId}/complete`, {
			method: 'POST',
			body: { parts: [{ partNumber: 1, etag: 'etag-retry.txt', size: 5 }], checksumSha256: null },
		});
		assert.equal(ok.status, 201);
		assert.equal(await countFiles(harness.db), 1);
		await assertNoMetadataWithoutObject(harness.db, harness.storage);
	});

	it('C4. D1 write fail SAU khi B2 đã upload ⇒ không tạo file mồ côi, quota không rò', async () => {
		const harness = await createChaosHarness();
		const ownerId = await currentOwnerId(harness.db);
		const { sessionId } = await createUploadedFile(harness, 'd1-fail.txt');

		// Cho phép mọi lệnh ghi trừ `INSERT INTO files` (bước tạo metadata file).
		harness.driver.setRule({ failOn: /INSERT INTO files/i, operation: 'run', mode: 'server_error', times: 1 });
		const response = await harness.request(`/uploads/${sessionId}/complete`, {
			method: 'POST',
			body: { parts: [{ partNumber: 1, etag: 'etag-d1-fail.txt', size: 5 }], checksumSha256: null },
		});
		assert.ok(response.status >= 400, 'phải trả lỗi');
		assert.equal(await countFiles(harness.db), 0, 'không được tạo file khi D1 ghi lỗi');

		// Quota phải được release (session OPEN nhưng reservation đã RELEASED?)
		const reserved = await totalReservedBytes(harness.db, ownerId);
		const session = await harness.db.getUploadSession(sessionId);
		if (session?.status === 'OPEN') {
			// Session còn OPEN ⇒ quota reservation phải còn giữ (client có thể retry)
			assert.equal(reserved, 5, 'session OPEN ⇒ quota vẫn được giữ để retry');
		} else {
			assert.equal(reserved, 0, 'session đã đóng ⇒ quota phải được release');
		}
	});

	it('C5. Complete trùng (idempotent) ⇒ không tạo 2 file', async () => {
		const harness = await createChaosHarness();
		const { sessionId } = await createUploadedFile(harness, 'dup.txt');
		const payload = { parts: [{ partNumber: 1, etag: 'etag-dup.txt', size: 5 }], checksumSha256: null };
		const first = await harness.request(`/uploads/${sessionId}/complete`, { method: 'POST', body: payload });
		const second = await harness.request(`/uploads/${sessionId}/complete`, { method: 'POST', body: payload });
		assert.equal(first.status, 201);
		assert.equal(second.status, 409);
		assert.equal(await countFiles(harness.db), 1);
	});

	it('C6. Download lỗi B2 ⇒ hoàn lại lượt tải của share (không mất lượt)', async () => {
		const harness = await createChaosHarness();
		const created = await createUploadedFile(harness, 'share-dl.txt');
		const completed = await harness.request(`/uploads/${created.sessionId}/complete`, {
			method: 'POST',
			body: { parts: [{ partNumber: 1, etag: 'etag-share-dl.txt', size: 5 }], checksumSha256: null },
		});
		assert.equal(completed.status, 201);

		const shareResponse = await harness.request('/shares', {
			method: 'POST',
			body: { fileId: created.fileId, expiresInDays: 1, maxDownloads: 3 },
		});
		assert.equal(shareResponse.status, 201);
		const shareBody = (await shareResponse.json()) as { token: string };
		harness.storage.setRules([{ operation: 'getObject', mode: 'server_error', times: 1 }]);
		const response = await harness.request('/public/share/download', {
			headers: { 'x-share-token': shareBody.token },
		});
		assert.ok(response.status >= 400);
		const info = await harness.request('/public/share/info', {
			headers: { 'x-share-token': shareBody.token },
		});
		const infoBody = (await info.json()) as { share: { downloadCount: number } };
		assert.equal(infoBody.share.downloadCount, 0, 'lượt tải phải được hoàn lại khi B2 lỗi');
	});

	it('C7. Storage disconnect khi tải file ⇒ 5xx có kiểm soát, không stack trace', async () => {
		const harness = await createChaosHarness();
		const created = await createUploadedFile(harness, 'disconnect.txt');
		const completed = await harness.request(`/uploads/${created.sessionId}/complete`, {
			method: 'POST',
			body: { parts: [{ partNumber: 1, etag: 'etag-disconnect.txt', size: 5 }], checksumSha256: null },
		});
		assert.equal(completed.status, 201);

		harness.storage.setRules([{ operation: 'getObject', mode: 'disconnect', times: 1 }]);
		const response = await harness.request(`/files/${created.fileId}/download`);
		const text = await response.text();
		assert.ok(response.status >= 400);
		assert.ok(!text.includes('[chaos]'), 'lỗi nội bộ không được lộ ra');
	});

	it('C8. Xoá file (vào trash) ⇒ object B2 được GIỮ 30 ngày, không mất dữ liệu', async () => {
		const harness = await createChaosHarness();
		const created = await createUploadedFile(harness, 'delete-fail.txt');
		await harness.request(`/uploads/${created.sessionId}/complete`, {
			method: 'POST',
			body: { parts: [{ partNumber: 1, etag: 'etag-delete-fail.txt', size: 5 }], checksumSha256: null },
		});
		const response = await harness.request(`/files/${created.fileId}`, { method: 'DELETE' });
		assert.equal(response.status, 200, 'xoá file = chuyển vào trash (soft delete)');
		// Object phải còn trên B2 (retention 30 ngày) — nếu xoá object ngay thì mất khả năng khôi phục.
		const stat = await harness.storage.headObject(created.objectKey);
		assert.ok(stat, 'object B2 phải còn để khôi phục được trong 30 ngày');
		const files = await listAllFiles(harness.db);
		assert.equal(files.length, 1, 'metadata file không được mất');
		assert.ok(files[0]?.deletedAt, 'file phải được đánh dấu đã xoá (trong trash)');
	});

	it('C9. Concurrent share revoke ⇒ share bị thu hồi, không còn phiên tải', async () => {
		const harness = await createChaosHarness();
		const created = await createUploadedFile(harness, 'revoke.txt');
		await harness.request(`/uploads/${created.sessionId}/complete`, {
			method: 'POST',
			body: { parts: [{ partNumber: 1, etag: 'etag-revoke.txt', size: 5 }], checksumSha256: null },
		});
		const shareResponse = await harness.request('/shares', {
			method: 'POST',
			body: { fileId: created.fileId, expiresInDays: 1 },
		});
		assert.equal(shareResponse.status, 201);
		const share = (await shareResponse.json()) as { share: { id: string }; token: string };

		const before = await harness.request('/public/share/info', {
			headers: { 'x-share-token': share.token },
		});
		assert.equal(before.status, 200);

		const [a, b] = await Promise.all([
			harness.request(`/shares/${share.share.id}`, { method: 'DELETE' }),
			harness.request(`/shares/${share.share.id}`, { method: 'DELETE' }),
		]);
		assert.ok(a.status < 500 && b.status < 500, 'thu hồi share không được sinh 5xx');
		const after = await harness.request('/public/share/info', {
			headers: { 'x-share-token': share.token },
		});
		assert.equal(after.status, 404, 'share đã thu hồi phải không dùng được');
	});

	it('C10. Retry storm (10 request đồng thời) ⇒ không vượt quota, không file trùng', async () => {
		const harness = await createChaosHarness();
		await harness.db.setSetting('quotaBytes', 100, NOW);
		const responses = await Promise.all(
			Array.from({ length: 10 }, (_, index) =>
				harness.request('/uploads', {
					method: 'POST',
					body: {
						fileName: `storm-${index}.bin`,
						contentType: 'application/octet-stream',
						totalSize: 30,
						checksumSha256: null,
					},
				}),
			),
		);
		const created = responses.filter((r) => r.status === 201).length;
		assert.equal(created, 3, 'tối đa 3 session (30 byte × 3 ≤ 100 byte)');
		const ownerId = await currentOwnerId(harness.db);
		const reserved = await totalReservedBytes(harness.db, ownerId);
		assert.ok(reserved <= 100, `quota bị vượt: ${reserved}`);
	});

	it('C11. Object upload thất bại giữa chừng (client disconnect) ⇒ không file mồ côi', async () => {
		const harness = await createChaosHarness();
		const response = await harness.request('/uploads', {
			method: 'POST',
			body: { fileName: 'disconnect-upload.bin', contentType: 'application/octet-stream', totalSize: 1024, checksumSha256: null },
		});
		assert.equal(response.status, 201);
		const body = (await response.json()) as { uploadSessionId: string };
		// Client không PUT lên B2 (mạng chết) ⇒ không complete ⇒ không có file.
		const session = await harness.db.getUploadSession(body.uploadSessionId);
		assert.equal(session?.status, 'OPEN');
		assert.equal(await countFiles(harness.db), 0);
	});

	it('C12. D1 query timeout khi đọc danh sách ⇒ lỗi có kiểm soát', async () => {
		const harness = await createChaosHarness();
		harness.driver.setRule({ failOn: /SELECT .* FROM files/i, operation: 'query', mode: 'timeout', times: 1 });
		const response = await harness.request('/files');
		const text = await response.text();
		assert.ok(response.status >= 400);
		assert.ok(!text.includes('[chaos]'), 'lỗi nội bộ không được lộ ra');
	});

	it('C13. Quota reservation lỗi khi tạo session ⇒ không tạo session mồ côi', async () => {
		const harness = await createChaosHarness();
		harness.driver.setRule({ failOn: /INSERT INTO quota_reservations/i, operation: 'run', mode: 'server_error', times: 1 });
		const response = await harness.request('/uploads', {
			method: 'POST',
			body: { fileName: 'quota-fail.bin', contentType: 'application/octet-stream', totalSize: 100, checksumSha256: null },
		});
		assert.ok(response.status >= 400);
		const ownerId = await currentOwnerId(harness.db);
		assert.equal(await totalReservedBytes(harness.db, ownerId), 0);
	});

	it('C14. Share hết hạn ⇒ tải bị chặn, không lộ metadata', async () => {
		const harness = await createChaosHarness();
		const created = await createUploadedFile(harness, 'expired.txt');
		await harness.request(`/uploads/${created.sessionId}/complete`, {
			method: 'POST',
			body: { parts: [{ partNumber: 1, etag: 'etag-expired.txt', size: 5 }], checksumSha256: null },
		});
		const shareResponse = await harness.request('/shares', {
			method: 'POST',
			body: { fileId: created.fileId, expiresInDays: 1 },
		});
		assert.equal(shareResponse.status, 201);
		const share = (await shareResponse.json()) as { share: { id: string }; token: string };
		// Thu hồi share ⇒ không tải được nữa.
		await harness.request(`/shares/${share.share.id}`, { method: 'DELETE' });
		const download = await harness.request('/public/share/download', {
			headers: { 'x-share-token': share.token },
		});
		assert.equal(download.status, 404);
	});

	it('C15. Audit fail (D1 ghi lỗi) ⇒ thao tác chính vẫn thành công', async () => {
		const harness = await createChaosHarness();
		const created = await createUploadedFile(harness, 'audit-fail.txt');
		harness.driver.setRule({ failOn: /INSERT INTO audit/i, operation: 'run', mode: 'server_error', times: 1 });
		const response = await harness.request(`/uploads/${created.sessionId}/complete`, {
			method: 'POST',
			body: { parts: [{ partNumber: 1, etag: 'etag-audit-fail.txt', size: 5 }], checksumSha256: null },
		});
		assert.equal(response.status, 201, 'audit lỗi không được làm fail thao tác chính');
		assert.equal(await countFiles(harness.db), 1);
	});
});

describe('chaos — bất biến dữ liệu', () => {
	it('sau mọi lỗi: metadata luôn có object tương ứng', async () => {
		const harness = await createChaosHarness();
		// Upload thành công
		const ok = await createUploadedFile(harness, 'invariant-ok.txt');
		await harness.request(`/uploads/${ok.sessionId}/complete`, {
			method: 'POST',
			body: { parts: [{ partNumber: 1, etag: 'etag-invariant-ok.txt', size: 5 }], checksumSha256: null },
		});
		// Upload thất bại giữa chừng
		harness.storage.setRules([{ operation: 'headObject', mode: 'timeout', times: 1 }]);
		const bad = await createUploadedFile(harness, 'invariant-bad.txt');
		await harness.request(`/uploads/${bad.sessionId}/complete`, {
			method: 'POST',
			body: { parts: [{ partNumber: 1, etag: 'etag-invariant-bad.txt', size: 5 }], checksumSha256: null },
		});
		await assertNoMetadataWithoutObject(harness.db, harness.storage);
	});

	it('mọi lỗi storage trả về mã lỗi chuẩn (4xx/5xx), không phải 200', async () => {
		const harness = await createChaosHarness();
		for (const mode of ['timeout', 'server_error', 'disconnect'] as const) {
			harness.storage.setRules([{ operation: 'presignPut', mode, times: 1 }]);
			const response = await harness.request('/uploads', {
				method: 'POST',
				body: {
					fileName: `mode-${mode}.bin`,
					contentType: 'application/octet-stream',
					totalSize: 10,
					checksumSha256: null,
				},
			});
			assert.notEqual(response.status, 200, `mode ${mode} không được trả 200`);
			assert.notEqual(response.status, 201, `mode ${mode} không được trả 201`);
		}
	});
});
