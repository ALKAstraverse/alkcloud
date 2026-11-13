#!/usr/bin/env node
/**
 * AlkCloud — Production E2E harness (chạy trên tài nguyên THẬT).
 *
 *   npm run test:e2e
 *
 * Yêu cầu (thiếu ⇒ SKIP/BLOCKED rõ ràng, KHÔNG giả lập PASS):
 *   ALKCLOUD_E2E_API_URL      (VD: https://api.alk.xx.kg/api/v1)
 *   ALKCLOUD_E2E_ORIGIN       (mặc định https://cloud.alk.xx.kg — phải có trong allowlist)
 *   ALKCLOUD_E2E_EMAIL        (email owner)
 *   ALKCLOUD_E2E_AUTH_KEY     (output Argon2id của owner, base64url)
 *   ALKCLOUD_E2E_SETUP_TOKEN  (chỉ dùng khi DB chưa có owner — bootstrap 1 lần)
 *   ALKCLOUD_TEST_B2_ENDPOINT / _REGION / _BUCKET / _KEY_ID / _APP_KEY (dọn object test)
 *
 * An toàn:
 * - Object test có prefix `alkcloud-e2e/`; cleanup CHỈ xoá object có key đó.
 * - KHÔNG xoá file/share ngoài phạm vi test do chính harness tạo.
 * - KHÔNG ghi secret vào báo cáo.
 * - Báo cáo: e2e-report.json + e2e-report.md (gitignored).
 * - SKIP/BLOCKED KHÔNG được tính là PASS.
 */

import { writeFileSync } from 'node:fs';
import { B2Storage } from '../packages/storage/src/index.js';

const API = process.env.ALKCLOUD_E2E_API_URL ?? '';
const ORIGIN = process.env.ALKCLOUD_E2E_ORIGIN ?? 'https://cloud.alk.xx.kg';
const SETUP_TOKEN = process.env.ALKCLOUD_E2E_SETUP_TOKEN ?? '';
const AUTH_KEY = process.env.ALKCLOUD_E2E_AUTH_KEY ?? '';
const EMAIL = process.env.ALKCLOUD_E2E_EMAIL ?? '';
// KHÔNG được chứa '/' — API cấm ký tự phân tách trong tên (nameSchema).
// Prefix cũ 'alkcloud-e2e/' làm mọi payload folder/upload/share bị 400.
const PREFIX = 'alkcloud-e2e-';

interface StepResult {
	name: string;
	status: 'PASS' | 'FAIL' | 'SKIP' | 'BLOCKED';
	detail: string;
	ms: number;
}

const results: StepResult[] = [];
let cookie = '';
let csrf = '';
/**
 * B2 có được cấu hình không (đọc từ /system/health/deep).
 *
 * Khi KHÔNG có B2 ⇒ các bước upload/download/share không thể chạy. Báo
 * `BLOCKED` (vướng môi trường) chứ KHÔNG báo `FAIL` — FAIL ám chỉ lỗi sản
 * phẩm, còn đây là thiếu credential hạ tầng. Theo quy ước của cả repo:
 * SKIP/BLOCKED không tính là PASS.
 */
let storageConfigured = false;

function log(line: string): void {
	console.log(line);
}

/**
 * Bước phụ thuộc B2: nếu B2 chưa cấu hình ⇒ BLOCKED (không phải FAIL).
 */
async function storageStep(name: string, fn: () => Promise<string>): Promise<boolean> {
	if (!storageConfigured) {
		blocked(name, 'B2 chưa cấu hình (storageConfigured=false) — cần credential B2 hợp lệ');
		return false;
	}
	return step(name, fn);
}

async function step(name: string, fn: () => Promise<string>): Promise<boolean> {
	const started = Date.now();
	try {
		const detail = await fn();
		results.push({ name, status: 'PASS', detail, ms: Date.now() - started });
		log(`PASS    ${name} — ${detail}`);
		return true;
	} catch (error) {
		const detail = error instanceof Error ? error.message : String(error);
		results.push({ name, status: 'FAIL', detail, ms: Date.now() - started });
		log(`FAIL    ${name} — ${detail}`);
		return false;
	}
}

function skip(name: string, detail: string): void {
	results.push({ name, status: 'SKIP', detail, ms: 0 });
	log(`SKIP    ${name} — ${detail}`);
}

function blocked(name: string, detail: string): void {
	results.push({ name, status: 'BLOCKED', detail, ms: 0 });
	log(`BLOCKED ${name} — ${detail}`);
}

async function api(
	path: string,
	options: { method?: string; body?: unknown; headers?: Record<string, string>; raw?: boolean } = {},
): Promise<Response> {
	const method = options.method ?? 'GET';
	const headers: Record<string, string> = {
		origin: ORIGIN,
		...(cookie ? { cookie } : {}),
		...(csrf && method !== 'GET' ? { 'x-alkcloud-csrf': csrf } : {}),
		...(options.body !== undefined ? { 'content-type': 'application/json' } : {}),
		...(options.headers ?? {}),
	};
	const response = await fetch(`${API}${path}`, {
		method,
		headers,
		body: options.body === undefined ? undefined : JSON.stringify(options.body),
	});
	if (options.raw) return response;
	const setCookie = response.headers.get('set-cookie');
	if (setCookie && setCookie.includes('__Secure-alk_session')) {
		cookie = setCookie.split(';')[0] ?? cookie;
	}
	return response;
}

async function apiJson<T>(path: string, options: Parameters<typeof api>[1] = {}): Promise<T> {
	const response = await api(path, options);
	if (!response.ok) {
		const body = await response.text().catch(() => '');
		throw new Error(`HTTP ${response.status} ${path} — ${body.slice(0, 200)}`);
	}
	return (await response.json()) as T;
}

function assert(condition: unknown, message: string): asserts condition {
	if (!condition) throw new Error(message);
}

/** SHA-256 hex — verifier share (khớp `deriveShareVerifier` của web). */
async function shareVerifier(password: string): Promise<string> {
	const digest = await crypto.subtle.digest(
		'SHA-256',
		new TextEncoder().encode(`alkcloud-share-v1:${password}`),
	);
	return Array.from(new Uint8Array(digest))
		.map((byte) => byte.toString(16).padStart(2, '0'))
		.join('');
}

function b2Storage(): B2Storage | null {
	const endpoint = process.env.ALKCLOUD_TEST_B2_ENDPOINT ?? '';
	const region = process.env.ALKCLOUD_TEST_B2_REGION ?? '';
	const bucket = process.env.ALKCLOUD_TEST_B2_BUCKET ?? '';
	const keyId = process.env.ALKCLOUD_TEST_B2_KEY_ID ?? '';
	const appKey = process.env.ALKCLOUD_TEST_B2_APP_KEY ?? '';
	if (!endpoint || !region || !bucket || !keyId || !appKey) return null;
	return new B2Storage({ endpoint, region, bucket, accessKeyId: keyId, secretAccessKey: appKey });
}

async function main(): Promise<void> {
	log('== AlkCloud — Production E2E (tài nguyên thật) ==');
	log(`API: ${API || '(chưa cấu hình)'}`);
	log(`Origin: ${ORIGIN}`);

	if (!API) {
		blocked('harness', 'thiếu ALKCLOUD_E2E_API_URL — không thể chạy E2E');
		report();
		return;
	}

	// ---------------------------------------------------------------- health
	await step('health', async () => {
		const body = await apiJson<{ status: string; service: string }>('/health');
		assert(body.status === 'ok', `health trả ${JSON.stringify(body)}`);
		return `${body.service} ok`;
	});

	// ---------------------------------------------------------------- auth
	let authenticated = false;
	await step('auth: bootstrap hoặc login', async () => {
		const status = await apiJson<{ bootstrapped: boolean }>('/auth/status');
		if (!status.bootstrapped) {
			assert(SETUP_TOKEN, 'DB chưa có owner và thiếu ALKCLOUD_E2E_SETUP_TOKEN');
			assert(AUTH_KEY, 'thiếu ALKCLOUD_E2E_AUTH_KEY');
			const response = await api('/auth/bootstrap', {
				method: 'POST',
				body: {
					setupToken: SETUP_TOKEN,
					email: EMAIL || 'e2e@alkcloud.test',
					authKey: AUTH_KEY,
					authVerifierSalt: 'e2e-salt-1234',
					authParams: 'e2e-params-1234',
				},
			});
			assert(
				response.status === 201,
				`bootstrap trả ${response.status}: ${(await response.clone().text()).slice(0, 160)}`,
			);
			const body = (await response.json()) as { session: { csrfToken: string } };
			csrf = body.session.csrfToken;
			authenticated = true;
			return 'bootstrap thành công (owner mới)';
		}
		assert(AUTH_KEY && EMAIL, 'thiếu ALKCLOUD_E2E_EMAIL / ALKCLOUD_E2E_AUTH_KEY để đăng nhập');
		const response = await api('/auth/login', {
			method: 'POST',
			body: { email: EMAIL, authKey: AUTH_KEY },
		});
		assert(
			response.status === 200,
			`login trả ${response.status}: ${(await response.clone().text()).slice(0, 160)}`,
		);
		const body = (await response.json()) as { session: { csrfToken: string } };
		csrf = body.session.csrfToken;
		authenticated = true;
		return `login thành công (${EMAIL})`;
	});

	if (!authenticated) {
		blocked('storage/sharing', 'không đăng nhập được ⇒ các bước còn lại không chạy');
		report();
		return;
	}

	// Trạng thái lớp lưu trữ — quyết định bước nào chạy được, bước nào BLOCKED.
	try {
		const deep = await apiJson<{ storageConfigured: boolean }>('/system/health/deep');
		storageConfigured = Boolean(deep.storageConfigured);
		log(`info: storageConfigured=${storageConfigured}`);
	} catch {
		storageConfigured = false;
	}

	// ------------------------------------------------- CSRF / Origin enforcement
	await step('security: CSRF bắt buộc', async () => {
		const response = await fetch(`${API}/files`, {
			method: 'GET',
			headers: { origin: ORIGIN, cookie },
		});
		assert(response.status === 200, `GET files (safe method) phải 200, trả ${response.status}`);
		const withoutCsrf = await fetch(`${API}/folders`, {
			method: 'POST',
			headers: { origin: ORIGIN, cookie, 'content-type': 'application/json' },
			body: JSON.stringify({ name: `${PREFIX}csrf-probe`, parentId: null }),
		});
		assert(withoutCsrf.status === 403, `POST thiếu CSRF phải 403, trả ${withoutCsrf.status}`);
		return 'safe method OK, unsafe method thiếu CSRF bị 403';
	});

	await step('security: Origin sai bị chặn', async () => {
		const response = await fetch(`${API}/folders`, {
			method: 'POST',
			headers: {
				origin: 'https://evil.example',
				cookie,
				'x-alkcloud-csrf': csrf,
				'content-type': 'application/json',
			},
			body: JSON.stringify({ name: `${PREFIX}origin-probe`, parentId: null }),
		});
		assert(response.status === 403, `Origin sai phải 403, trả ${response.status}`);
		return 'Origin không thuộc allowlist bị 403';
	});

	// ---------------------------------------------------------------- folders
	let folderId = '';
	await step('folders: tạo / đổi tên / xoá / khôi phục', async () => {
		const created = await apiJson<{ folder: { id: string } }>('/folders', {
			method: 'POST',
			body: { name: `${PREFIX}folder`, parentId: null },
		});
		folderId = created.folder.id;
		const rename = await api(`/folders/${folderId}`, { method: 'PATCH', body: { name: `${PREFIX}folder-renamed` } });
		assert(rename.status === 200, `rename folder trả ${rename.status}`);
		const del = await api(`/folders/${folderId}`, { method: 'DELETE' });
		assert(del.status === 200, `delete folder trả ${del.status}`);
		const restore = await api(`/folders/${folderId}/restore`, { method: 'POST', body: {} });
		assert(restore.status === 200, `restore folder trả ${restore.status}`);
		return `folder ${folderId}`;
	});

	// ---------------------------------------------------------------- upload
	let fileId = '';
	let objectKey = '';
	await storageStep('upload: single-part (presign PUT + complete)', async () => {
		const session = await apiJson<{
			uploadSessionId: string;
			mode: string;
			parts: Array<{ partNumber: number; url: string; headers: Record<string, string> }>;
		}>('/uploads', {
			method: 'POST',
			body: {
				fileName: `${PREFIX}probe.txt`,
				contentType: 'text/plain',
				totalSize: 5,
				checksumSha256: null,
				folderId: null,
			},
		});
		assert(session.mode === 'single', `mode phải là single, trả ${session.mode}`);
		const part = session.parts[0];
		assert(part, 'không có part URL');
		const put = await fetch(part.url, {
			method: 'PUT',
			headers: { 'content-type': 'text/plain', ...(part.headers ?? {}) },
			body: 'hello',
		});
		assert(put.ok, `PUT lên B2 trả ${put.status}`);
		const complete = await apiJson<{ file: { id: string; objectKey: string; size: number } }>(
			`/uploads/${session.uploadSessionId}/complete`,
			{ method: 'POST', body: { parts: [], checksumSha256: null } },
		);
		assert(complete.file.size === 5, `size phải là 5, trả ${complete.file.size}`);
		fileId = complete.file.id;
		objectKey = complete.file.objectKey;
		return `file ${fileId}, object ${objectKey}`;
	});

	await storageStep('upload: multipart (presign part + complete thiếu part bị chặn + abort)', async () => {
		const session = await apiJson<{
			uploadSessionId: string;
			mode: string;
			uploadId: string;
			partCount: number;
			parts: Array<{ partNumber: number; url: string }>;
		}>('/uploads', {
			method: 'POST',
			body: {
				fileName: `${PREFIX}multipart.bin`,
				contentType: 'application/octet-stream',
				totalSize: 101 * 1024 * 1024,
				checksumSha256: null,
				folderId: null,
			},
		});
		assert(session.mode === 'multipart', `mode phải là multipart, trả ${session.mode}`);
		assert(session.partCount === 2, `partCount phải là 2 (101MB/64MB), trả ${session.partCount}`);
		assert(session.parts.length === 2, `phải có 2 part URL, trả ${session.parts.length}`);

		// complete khi chưa upload part ⇒ phải bị chặn (400) chứ không tạo file rỗng.
		const badComplete = await api(`/uploads/${session.uploadSessionId}/complete`, {
			method: 'POST',
			body: {
				uploadId: session.uploadId,
				parts: [{ partNumber: 1, etag: 'fake-etag', size: 64 * 1024 * 1024 }],
				checksumSha256: null,
			},
		});
		assert(badComplete.status === 400, `complete thiếu part phải 400, trả ${badComplete.status}`);

		// abort ⇒ session ABORTED, quota được hoàn lại.
		const abort = await api(`/uploads/${session.uploadSessionId}`, {
			method: 'DELETE',
			body: { uploadId: session.uploadId },
		});
		assert(abort.status === 200, `abort trả ${abort.status}`);
		const state = await apiJson<{ status: string }>(`/uploads/${session.uploadSessionId}`);
		assert(state.status === 'ABORTED', `session phải ABORTED, trả ${state.status}`);
		return `multipart ${session.partCount} part, complete-thiếu-part bị chặn, abort OK`;
	});

	// ---------------------------------------------------------------- download
	await storageStep('download: full + Range 206 + content-disposition', async () => {
		const response = await api(`/files/${fileId}/download`, { raw: true });
		assert(response.status === 200, `download trả ${response.status}`);
		const text = await response.text();
		assert(text.length === 5, `phải nhận 5 byte, nhận ${text.length}`);
		const disposition = response.headers.get('content-disposition') ?? '';
		assert(disposition.includes("filename*=UTF-8''"), `content-disposition thiếu RFC5987: ${disposition}`);

		const ranged = await api(`/files/${fileId}/download`, { raw: true, headers: { range: 'bytes=0-2' } });
		assert(ranged.status === 206, `Range phải trả 206, thực tế ${ranged.status}`);
		const body = await ranged.text();
		assert(body.length === 3, `phải nhận 3 byte, nhận ${body.length}`);
		return `200 (5 byte) + 206 (3 byte), ${disposition.slice(0, 48)}`;
	});

	await storageStep('download: owner luôn được phép kể cả EMERGENCY (assert capability)', async () => {
		const open = await api(`/files/${fileId}/open`, { raw: true });
		assert(open.status === 200, `presign GET phải 200, trả ${open.status}`);
		const body = (await open.json()) as { url: string; expiresAt: string };
		assert(body.url.includes('X-Amz-Signature'), 'URL phải có chữ ký S3');
		return `presign GET hết hạn ${body.expiresAt}`;
	});

	// ---------------------------------------------------------------- rename/move/trash
	await storageStep('files: rename + move + trash + restore', async () => {
		const rename = await api(`/files/${fileId}`, { method: 'PATCH', body: { name: `${PREFIX}renamed.txt` } });
		assert(rename.status === 200, `rename trả ${rename.status}`);
		const move = await api(`/files/${fileId}/move`, { method: 'POST', body: { folderId } });
		assert(move.status === 200, `move trả ${move.status}`);
		const del = await api(`/files/${fileId}`, { method: 'DELETE' });
		assert(del.status === 200, `delete trả ${del.status}`);
		const trash = await apiJson<{ files: Array<{ id: string }> }>('/files/trash');
		assert(trash.files.some((item) => item.id === fileId), 'file không có trong trash');
		const restore = await api(`/files/${fileId}/restore`, { method: 'POST', body: {} });
		assert(restore.status === 200, `restore trả ${restore.status}`);
		// trả về root để cleanup gọn
		const moveRoot = await api(`/files/${fileId}/move`, { method: 'POST', body: { folderId: null } });
		assert(moveRoot.status === 200, `move về root trả ${moveRoot.status}`);
		return 'rename/move/trash/restore OK';
	});

	await storageStep('files: purge trước hạn bị chặn (409)', async () => {
		await api(`/files/${fileId}`, { method: 'DELETE' });
		const purge = await api(`/files/${fileId}/purge`, { method: 'DELETE' });
		assert(purge.status === 409, `purge trước hạn phải 409, trả ${purge.status}`);
		const restore = await api(`/files/${fileId}/restore`, { method: 'POST', body: {} });
		assert(restore.status === 200, `restore lại trả ${restore.status}`);
		return '409 đúng (retention 30 ngày)';
	});

	// ---------------------------------------------------------------- sharing
	let shareToken = '';
	let shareId = '';
	await storageStep('sharing: tạo share có mật khẩu + metadata ẩn trước unlock', async () => {
		const created = await apiJson<{ share: { id: string }; token: string }>('/shares', {
			method: 'POST',
			body: {
				fileId,
				expiresInDays: 1,
				maxDownloads: 2,
				passwordVerifier: await shareVerifier('e2e-password'),
				passwordSalt: 'e2e-salt-1234',
				passwordParams: 'sha256',
			},
		});
		shareToken = created.token;
		shareId = created.share.id;
		const info = await apiJson<{ share: { fileName: string | null; requiresPassword: boolean; unlocked: boolean } }>(
			'/public/share/info',
			{ headers: { 'x-share-token': shareToken } },
		);
		assert(info.share.requiresPassword, 'phải yêu cầu mật khẩu');
		assert(info.share.fileName === null, 'metadata phải bị ẩn trước unlock');
		assert(info.share.unlocked === false, 'chưa unlock');
		return `share ${shareId}, metadata ẩn OK`;
	});

	await storageStep('sharing: unlock sai mật khẩu bị 403', async () => {
		const response = await api('/public/share/unlock', {
			method: 'POST',
			body: { passwordVerifier: await shareVerifier('wrong-password') },
			headers: { 'x-share-token': shareToken },
		});
		assert(response.status === 403, `sai mật khẩu phải 403, trả ${response.status}`);
		return '403 đúng';
	});

	await storageStep('sharing: unlock đúng + download bằng grant header', async () => {
		const unlock = await apiJson<{ grant: string; share: { unlocked: boolean } }>('/public/share/unlock', {
			method: 'POST',
			body: { passwordVerifier: await shareVerifier('e2e-password') },
			headers: { 'x-share-token': shareToken },
		});
		assert(unlock.grant, 'unlock phải trả grant');
		assert(unlock.share.unlocked, 'phải unlocked');
		const download = await api('/public/share/download', {
			raw: true,
			headers: { 'x-share-token': shareToken, 'x-share-grant': unlock.grant },
		});
		assert(download.status === 200, `share download trả ${download.status}`);
		const text = await download.text();
		assert(text.length === 5, `phải nhận 5 byte, nhận ${text.length}`);
		return 'grant header OK';
	});

	await storageStep('sharing: download không grant bị 403', async () => {
		const response = await api('/public/share/download', {
			raw: true,
			headers: { 'x-share-token': shareToken },
		});
		assert(response.status === 403, `thiếu grant phải 403, trả ${response.status}`);
		return '403 đúng';
	});

	await storageStep('sharing: maxDownloads + revoke', async () => {
		const unlock = await apiJson<{ grant: string }>('/public/share/unlock', {
			method: 'POST',
			body: { passwordVerifier: await shareVerifier('e2e-password') },
			headers: { 'x-share-token': shareToken },
		});
		// Lượt 1 (đã dùng 1/2 ở bước trước) + lượt 2 = đủ 2 lượt.
		const second = await api('/public/share/download', {
			raw: true,
			headers: { 'x-share-token': shareToken, 'x-share-grant': unlock.grant },
		});
		assert(second.status === 200, `lượt 2 phải 200, trả ${second.status}`);
		const third = await api('/public/share/download', {
			raw: true,
			headers: { 'x-share-token': shareToken, 'x-share-grant': unlock.grant },
		});
		assert(third.status === 403, `lượt 3 phải 403, trả ${third.status}`);
		const revoke = await api(`/shares/${shareId}`, { method: 'DELETE' });
		assert(revoke.status === 200, `revoke trả ${revoke.status}`);
		const after = await api('/public/share/download', {
			raw: true,
			headers: { 'x-share-token': shareToken, 'x-share-grant': unlock.grant },
		});
		assert(after.status === 404, `sau revoke phải 404, thực tế ${after.status}`);
		return 'maxDownloads chặn lượt 3 + revoke 404 OK';
	});

	// ---------------------------------------------------------------- system
	await step('system: quota + usage + health/deep', async () => {
		const quota = await apiJson<{ mode: string }>('/system/quota');
		assert(typeof quota.mode === 'string', 'quota phải có mode');
		const usage = await apiJson<{ usedBytes: number }>('/system/usage');
		assert(typeof usage.usedBytes === 'number', 'usage phải có usedBytes');
		// Contract thật: { status, bootstrapped, time, storageConfigured, analyticsConfigured }.
		const deep = await apiJson<{
			status: string;
			storageConfigured: boolean;
			analyticsConfigured: boolean;
		}>('/system/health/deep');
		assert(deep.status === 'ok', `health/deep phải status=ok, trả ${JSON.stringify(deep)}`);
		return `mode=${quota.mode}, usedBytes=${usage.usedBytes}, storage=${deep.storageConfigured}, analytics=${deep.analyticsConfigured}`;
	});

	await step('system: audit log ghi được thao tác', async () => {
		// Contract thật: { events: [...] }.
		const audit = await apiJson<{ events: Array<{ action: string }> }>('/system/audit?limit=10');
		assert(Array.isArray(audit.events), 'audit phải trả mảng events');
		assert(audit.events.length > 0, 'audit log rỗng');
		return `${audit.events.length} entry gần nhất`;
	});

	// ---------------------------------------------------------------- backup
	await step('backup: export D1 production', async () => {
		const { execFileSync } = await import('node:child_process');
		execFileSync(
			'npx',
			[
				'wrangler',
				'-c',
				'apps/api/wrangler.toml',
				'd1',
				'export',
				'alkcloud',
				'--remote',
				'--output',
				'backups/e2e-verify.sql',
				'--skip-confirmation',
			],
			{
				encoding: 'utf8',
				stdio: 'pipe',
				// wrangler cần token trong env (không truyền qua argv).
				env: {
					...process.env,
					CLOUDFLARE_API_TOKEN: process.env.CLOUDFLARE_API_TOKEN ?? '',
					CLOUDFLARE_ACCOUNT_ID: process.env.CLOUDFLARE_ACCOUNT_ID ?? '',
				},
			},
		);
		const { statSync } = await import('node:fs');
		const size = statSync('backups/e2e-verify.sql').size;
		assert(size > 0, 'file export rỗng');
		return `backups/e2e-verify.sql (${size} byte)`;
	});

	// ---------------------------------------------------------------- cleanup
	await step('cleanup: dọn object B2 của file test', async () => {
		const storage = b2Storage();
		if (!storage) {
			skip('cleanup: dọn object B2 của file test', 'thiếu ALKCLOUD_TEST_B2_* — không dọn được object');
			return 'SKIP (thiếu credential B2)';
		}
		if (!objectKey) return 'không có objectKey';
		const versions = await storage.listObjectVersions(objectKey);
		for (const version of versions) {
			await storage.deleteObjectVersion(objectKey, version.versionId);
		}
		if (versions.length === 0) await storage.deleteObject(objectKey);
		return `đã xoá ${objectKey} (${versions.length} version)`;
	});

	await step('cleanup: dọn file/folder test', async () => {
		if (fileId) {
			await api(`/files/${fileId}`, { method: 'DELETE' });
		}
		if (folderId) {
			await api(`/folders/${folderId}`, { method: 'DELETE' });
		}
		return 'file + folder test đã vào trash (cron sẽ purge sau 30 ngày)';
	});

	report();
}

function report(): void {
	const pass = results.filter((item) => item.status === 'PASS').length;
	const fail = results.filter((item) => item.status === 'FAIL').length;
	const skipCount = results.filter((item) => item.status === 'SKIP').length;
	const blockedCount = results.filter((item) => item.status === 'BLOCKED').length;

	const json = {
		generatedAt: new Date().toISOString(),
		api: API || null,
		origin: ORIGIN,
		summary: { pass, fail, skipped: skipCount, blocked: blockedCount },
		steps: results,
	};
	writeFileSync('e2e-report.json', `${JSON.stringify(json, null, 2)}\n`);

	const md = [
		'# AlkCloud — E2E report',
		'',
		`- Thời điểm: ${json.generatedAt}`,
		`- API: ${json.api ?? '(chưa cấu hình)'}`,
		`- Origin: ${ORIGIN}`,
		`- Kết quả: PASS=${pass} FAIL=${fail} SKIP=${skipCount} BLOCKED=${blockedCount}`,
		'',
		'> SKIP/BLOCKED **KHÔNG** được tính là PASS.',
		'',
		'| Bước | Trạng thái | Chi tiết | ms |',
		'| :--- | :--- | :--- | ---: |',
		...results.map(
			(item) => `| ${item.name} | ${item.status} | ${item.detail.replace(/\|/g, '\\|').slice(0, 160)} | ${item.ms} |`,
		),
		'',
	].join('\n');
	writeFileSync('e2e-report.md', md);

	log('');
	log(`Tổng kết: PASS=${pass} FAIL=${fail} SKIP=${skipCount} BLOCKED=${blockedCount}`);
	log('Báo cáo: e2e-report.json, e2e-report.md');
	// SKIP/BLOCKED KHÔNG được tính là PASS:
	//   FAIL    ⇒ exit 1 (có bước hỏng)
	//   BLOCKED ⇒ exit 2 (chưa đủ điều kiện chạy — KHÔNG phải xanh)
	//   SKIP    ⇒ exit 3 (có bước bị bỏ qua — KHÔNG phải xanh)
	if (fail > 0) process.exitCode = 1;
	else if (blockedCount > 0) process.exitCode = 2;
	else if (skipCount > 0) process.exitCode = 3;
}

void main();
