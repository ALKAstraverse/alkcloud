/**
 * Functional audit — integration test HTTP thật (không mock API).
 *
 * Chạy trên một stack API local đã bootstrap (D1 + object storage + relay):
 *   ALKCLOUD_AUDIT_BASE=http://127.0.0.1:8790/api/v1 \
 *   ALKCLOUD_AUDIT_ORIGIN=https://127.0.0.1:5174 \
 *   ALKCLOUD_AUDIT_SETUP_TOKEN=... \
 *   ALKCLOUD_AUDIT_PASSWORD=... \
 *   node --import tsx --test apps/api/test/integration/functional-audit.test.ts
 *
 * Không set ALKCLOUD_AUDIT_BASE ⇒ toàn bộ suite bị skip (CI không có stack).
 */
import assert from 'node:assert/strict';
import { createHash, randomBytes } from 'node:crypto';
import { before, describe, it } from 'node:test';
import { deriveAuthKey, toBase64Url } from '../../../../scripts/lib/auth-key.js';

const BASE = (process.env.ALKCLOUD_AUDIT_BASE ?? '').replace(/\/+$/, '');
const ORIGIN = process.env.ALKCLOUD_AUDIT_ORIGIN ?? 'https://127.0.0.1:5174';
const SETUP_TOKEN = process.env.ALKCLOUD_AUDIT_SETUP_TOKEN ?? '';
const PASSWORD = process.env.ALKCLOUD_AUDIT_PASSWORD ?? '';
const EMAIL = process.env.ALKCLOUD_AUDIT_EMAIL ?? 'owner@audit.local';
const KDF_PARAMS = JSON.stringify({
	algo: 'pbkdf2',
	hash: 'sha-256',
	iterations: 600000,
	outputLength: 32,
});
const MB = 1024 * 1024;
const SKIP = BASE ? false : 'thiếu ALKCLOUD_AUDIT_BASE';

interface ApiResponse<T> {
	status: number;
	body: T;
	headers: Headers;
}

interface RequestOptions extends RequestInit {
	json?: unknown;
	/** Bỏ qua Origin/CSRF mặc định (dùng để kiểm tra chặn sai). */
	raw?: boolean;
}

class AuditClient {
	cookie = '';
	csrf = '';

	async request(path: string, init: RequestOptions = {}): Promise<Response> {
		const method = (init.method ?? 'GET').toUpperCase();
		const headers = new Headers(init.headers);
		const safe = method === 'GET' || method === 'HEAD' || method === 'OPTIONS';
		if (!safe && !init.raw) {
			if (!headers.has('origin')) headers.set('origin', ORIGIN);
			if (!headers.has('x-alkcloud-csrf') && this.csrf) headers.set('x-alkcloud-csrf', this.csrf);
		}
		if (this.cookie) headers.set('cookie', this.cookie);
		let body = init.body;
		if (init.json !== undefined) {
			headers.set('content-type', 'application/json');
			body = JSON.stringify(init.json);
		}
		const response = await fetch(`${BASE}${path}`, { ...init, method, headers, body });
		for (const raw of response.headers.getSetCookie()) {
			const pair = raw.split(';')[0];
			if (pair?.startsWith('__Secure-alk_session=')) this.cookie = pair;
		}
		return response;
	}

	async call<T = Record<string, unknown>>(path: string, init: RequestOptions = {}): Promise<ApiResponse<T>> {
		const response = await this.request(path, init);
		const text = await response.text();
		let body: unknown = null;
		try {
			body = text ? JSON.parse(text) : null;
		} catch {
			body = { raw: text };
		}
		return { status: response.status, body: body as T, headers: response.headers };
	}
}

let client: AuditClient;

/** Verifier mật khẩu share: SHA-256 hex của `alkcloud-share-v1:<password>` (khớp web client). */
function shareVerifier(password: string): string {
	return createHash('sha256').update(`alkcloud-share-v1:${password}`).digest('hex');
}

async function ensureSession(): Promise<void> {
	const probe = new AuditClient();
	const status = await probe.call<{ bootstrapped: boolean }>('/auth/status');
	assert.equal(status.status, 200, `GET /auth/status trả ${status.status}`);
	if (!status.body.bootstrapped) {
		const salt = toBase64Url(randomBytes(16));
		const authKey = await deriveAuthKey(PASSWORD, salt, KDF_PARAMS);
		const boot = await probe.call('/auth/bootstrap', {
			method: 'POST',
			json: {
				setupToken: SETUP_TOKEN,
				email: EMAIL,
				authKey,
				authVerifierSalt: salt,
				authParams: KDF_PARAMS,
			},
		});
		assert.equal(boot.status, 201, `bootstrap thất bại: ${JSON.stringify(boot.body)}`);
	}
	const params = await probe.call<{ salt: string; params: string }>('/auth/params');
	assert.equal(params.status, 200);
	const authKey = await deriveAuthKey(PASSWORD, params.body.salt, params.body.params);
	const login = await probe.call<{ session: { csrfToken: string } }>('/auth/login', {
		method: 'POST',
		json: { email: EMAIL, authKey },
	});
	assert.equal(login.status, 200, `login thất bại: ${JSON.stringify(login.body)}`);
	probe.csrf = login.body.session.csrfToken;
	client = probe;
}

interface UploadedFile {
	id: string;
	name: string;
	size: number;
	folderId: string | null;
}

interface UploadSession {
	uploadSessionId: string;
	mode: string;
	uploadId?: string;
	partCount: number;
	parts: Array<{ partNumber: number }>;
}

async function createUploadSession(
	name: string,
	totalSize: number,
	folderId: string | null = null,
): Promise<UploadSession> {
	const response = await client.call<UploadSession>('/uploads', {
		method: 'POST',
		json: {
			fileName: name,
			contentType: 'application/octet-stream',
			totalSize,
			checksumSha256: null,
			folderId,
		},
	});
	assert.equal(response.status, 201, `tạo upload session thất bại: ${JSON.stringify(response.body)}`);
	return response.body;
}

async function uploadFile(
	name: string,
	content: Uint8Array,
	opts: { folderId?: string | null; contentType?: string } = {},
): Promise<UploadedFile> {
	const contentType = opts.contentType ?? 'application/octet-stream';
	const session = await createUploadSession(name, content.byteLength, opts.folderId ?? null);
	const put = await client.request(`/uploads/${session.uploadSessionId}/content`, {
		method: 'POST',
		body: content,
		headers: { 'content-type': contentType },
	});
	assert.equal(put.status, 200, `upload nội dung thất bại: ${put.status} ${await put.text()}`);
	const etag = put.headers.get('etag') ?? 'etag-unknown';
	const complete = await client.call<{ file: UploadedFile }>(`/uploads/${session.uploadSessionId}/complete`, {
		method: 'POST',
		json: {
			parts: [{ partNumber: 1, etag, size: content.byteLength }],
			uploadId: session.uploadId,
			checksumSha256: null,
		},
	});
	assert.equal(complete.status, 201, `hoàn tất upload thất bại: ${JSON.stringify(complete.body)}`);
	return complete.body.file;
}

async function createFolder(name: string, parentId: string | null = null): Promise<string> {
	const response = await client.call<{ folder: { id: string } }>('/folders', {
		method: 'POST',
		json: { name, parentId },
	});
	assert.equal(response.status, 201, `tạo folder thất bại: ${JSON.stringify(response.body)}`);
	return response.body.folder.id;
}

describe('functional audit — auth & csrf', { skip: SKIP }, () => {
	before(async () => {
		await ensureSession();
	});

	it('GET /auth/status không lộ email owner', async () => {
		const anonymous = new AuditClient();
		const response = await anonymous.call<{ bootstrapped: boolean; email?: string }>('/auth/status');
		assert.equal(response.status, 200);
		assert.equal(response.body.bootstrapped, true);
		assert.equal(response.body.email, undefined);
	});

	it('mutation thiếu CSRF bị chặn 403', async () => {
		const response = await client.call('/folders', {
			method: 'POST',
			json: { name: 'csrf-probe', parentId: null },
			raw: true,
		});
		assert.equal(response.status, 403, `csrf thiếu phải bị 403, nhận ${response.status}`);
	});

	it('mutation sai Origin bị chặn 403', async () => {
		const response = await client.call('/folders', {
			method: 'POST',
			json: { name: 'origin-probe', parentId: null },
			headers: { origin: 'https://evil.example', 'x-alkcloud-csrf': client.csrf },
		});
		assert.equal(response.status, 403, `origin lạ phải bị 403, nhận ${response.status}`);
	});

	it('GET /auth/params trả salt + params đủ để dẫn xuất authKey', async () => {
		const response = await client.call<{ salt: string; params: string }>('/auth/params');
		assert.equal(response.status, 200);
		assert.ok(response.body.salt.length >= 8);
		assert.ok(response.body.params.length >= 8);
	});
});

describe('functional audit — folders', { skip: SKIP }, () => {
	before(async () => {
		if (!client) await ensureSession();
	});

	it('vòng đời create → rename → move → delete → restore', async () => {
		const parent = await createFolder(`fa-parent-${Date.now()}`);
		const child = await createFolder(`fa-child-${Date.now()}`, parent);

		const renamed = await client.call(`/folders/${child}`, {
			method: 'PATCH',
			json: { name: `fa-child-renamed-${Date.now()}` },
		});
		assert.equal(renamed.status, 200, `rename folder thất bại: ${JSON.stringify(renamed.body)}`);

		const moved = await client.call(`/folders/${child}/move`, {
			method: 'POST',
			json: { parentId: null },
		});
		assert.equal(moved.status, 200, `move folder thất bại: ${JSON.stringify(moved.body)}`);

		const deleted = await client.call(`/folders/${child}`, { method: 'DELETE' });
		assert.equal(deleted.status, 200, `delete folder thất bại: ${JSON.stringify(deleted.body)}`);

		const restored = await client.call(`/folders/${child}/restore`, { method: 'POST' });
		assert.equal(restored.status, 200, `restore folder thất bại: ${JSON.stringify(restored.body)}`);
	});

	it('tạo folder trùng tên trong cùng cha → 409', async () => {
		const parent = await createFolder(`fa-dup-${Date.now()}`);
		await createFolder('same-name', parent);
		const duplicate = await client.call('/folders', {
			method: 'POST',
			json: { name: 'same-name', parentId: parent },
		});
		assert.equal(duplicate.status, 409, `trùng tên phải 409, nhận ${duplicate.status}`);
	});

	it('move folder vào chính nó / vào subtree → 400', async () => {
		const parent = await createFolder(`fa-self-${Date.now()}`);
		const child = await createFolder(`fa-self-child-${Date.now()}`, parent);
		const self = await client.call(`/folders/${parent}/move`, {
			method: 'POST',
			json: { parentId: parent },
		});
		assert.equal(self.status, 400, `move vào chính nó phải 400, nhận ${self.status}`);
		const intoChild = await client.call(`/folders/${parent}/move`, {
			method: 'POST',
			json: { parentId: child },
		});
		assert.equal(intoChild.status, 400, `move vào subtree phải 400, nhận ${intoChild.status}`);
	});

	it('move folder với body thiếu parentId → 400 (không lặng lẽ về root)', async () => {
		const folder = await createFolder(`fa-nobody-${Date.now()}`);
		const response = await client.call(`/folders/${folder}/move`, {
			method: 'POST',
			json: {},
		});
		assert.equal(response.status, 400, `body rỗng phải 400, nhận ${response.status}`);
	});

	it('rename folder với version sai → 409', async () => {
		const folder = await createFolder(`fa-ver-${Date.now()}`);
		const response = await client.call(`/folders/${folder}`, {
			method: 'PATCH',
			json: { name: 'renamed-with-stale-version', version: 99 },
		});
		assert.equal(response.status, 409, `version sai phải 409, nhận ${response.status}`);
	});

	it('xoá folder chứa file ⇒ file vào thùng rác và được khôi phục cùng cây', async () => {
		const folder = await createFolder(`fa-tree-${Date.now()}`);
		const file = await uploadFile(`fa-tree-file-${Date.now()}.txt`, new TextEncoder().encode('tree-data'), {
			folderId: folder,
		});
		const deleted = await client.call(`/folders/${folder}`, { method: 'DELETE' });
		assert.equal(deleted.status, 200, `delete folder thất bại: ${JSON.stringify(deleted.body)}`);

		const trash = await client.call<{ files: UploadedFile[] }>('/files?trashed=true&limit=200');
		assert.ok(
			trash.body.files.some((item) => item.id === file.id),
			'file trong folder phải nằm trong thùng rác sau khi xoá folder',
		);

		const restored = await client.call(`/folders/${folder}/restore`, { method: 'POST' });
		assert.equal(restored.status, 200, `restore folder thất bại: ${JSON.stringify(restored.body)}`);

		const trashAfter = await client.call<{ files: UploadedFile[] }>('/files?trashed=true&limit=200');
		assert.ok(
			!trashAfter.body.files.some((item) => item.id === file.id),
			'file phải được khôi phục cùng folder',
		);
	});
});

describe('functional audit — files', { skip: SKIP }, () => {
	before(async () => {
		if (!client) await ensureSession();
	});

	it('upload → list → download khớp nội dung', async () => {
		const payload = new TextEncoder().encode('alkcloud-functional-audit-content');
		const file = await uploadFile(`fa-basic-${Date.now()}.txt`, payload, { contentType: 'text/plain' });
		assert.equal(file.size, payload.byteLength);

		const listed = await client.call<{ files: UploadedFile[] }>('/files?limit=200');
		assert.ok(listed.body.files.some((item) => item.id === file.id));

		const download = await client.request(`/files/${file.id}/download`);
		assert.equal(download.status, 200);
		assert.equal(await download.text(), 'alkcloud-functional-audit-content');
	});

	it('move file với body thiếu folderId → 400 (không lặng lẽ về root)', async () => {
		const file = await uploadFile(`fa-move-${Date.now()}.txt`, new TextEncoder().encode('move'));
		const response = await client.call(`/files/${file.id}/move`, {
			method: 'POST',
			json: {},
		});
		assert.equal(response.status, 400, `body rỗng phải 400, nhận ${response.status}`);
	});

	it('move file vào folder không tồn tại → 404', async () => {
		const file = await uploadFile(`fa-move-404-${Date.now()}.txt`, new TextEncoder().encode('move'));
		const response = await client.call(`/files/${file.id}/move`, {
			method: 'POST',
			json: { folderId: 'fld_missing_000000000000' },
		});
		assert.equal(response.status, 404, `folder thiếu phải 404, nhận ${response.status}`);
	});

	it('rename file với version sai → 409', async () => {
		const file = await uploadFile(`fa-file-ver-${Date.now()}.txt`, new TextEncoder().encode('v'));
		const response = await client.call(`/files/${file.id}`, {
			method: 'PATCH',
			json: { name: 'renamed-stale.txt', version: 99 },
		});
		assert.equal(response.status, 409, `version sai phải 409, nhận ${response.status}`);
	});

	it('xoá file → trash → khôi phục', async () => {
		const file = await uploadFile(`fa-trash-${Date.now()}.txt`, new TextEncoder().encode('trash'));
		const deleted = await client.call(`/files/${file.id}`, { method: 'DELETE' });
		assert.equal(deleted.status, 200, `delete file thất bại: ${JSON.stringify(deleted.body)}`);

		const trash = await client.call<{ files: UploadedFile[] }>('/files?trashed=true&limit=200');
		assert.ok(trash.body.files.some((item) => item.id === file.id));

		const restored = await client.call(`/files/${file.id}/restore`, { method: 'POST' });
		assert.equal(restored.status, 200, `restore file thất bại: ${JSON.stringify(restored.body)}`);
	});

	it('danh sách >100 file phải phân trang được tới hết (cursor)', async () => {
		const marker = `fa-page-${Date.now()}`;
		const names: string[] = [];
		for (let index = 0; index < 101; index += 1) {
			const name = `${marker}-${String(index).padStart(3, '0')}.txt`;
			names.push(name);
			await uploadFile(name, new TextEncoder().encode(String(index)));
		}

		const seen = new Set<string>();
		let cursor: string | null = null;
		let pages = 0;
		do {
			const query = new URLSearchParams({ limit: '100' });
			if (cursor) query.set('cursor', cursor);
			const page = await client.call<{
				files: UploadedFile[];
				nextCursor?: string | null;
			}>(`/files?${query.toString()}`);
			assert.equal(page.status, 200, `list files lỗi: ${JSON.stringify(page.body)}`);
			for (const item of page.body.files) seen.add(item.name);
			cursor = page.body.nextCursor ?? null;
			pages += 1;
			assert.ok(pages < 10, 'cursor không tiến ⇒ có thể lặp vô hạn');
		} while (cursor);

		for (const name of names) {
			assert.ok(seen.has(name), `thiếu file trong danh sách phân trang: ${name}`);
		}
	});
});

describe('functional audit — upload', { skip: SKIP }, () => {
	before(async () => {
		if (!client) await ensureSession();
	});

	it('upload 0 byte bị từ chối (schema totalSize >= 1)', async () => {
		const response = await client.call('/uploads', {
			method: 'POST',
			json: {
				fileName: `fa-empty-${Date.now()}.txt`,
				contentType: 'text/plain',
				totalSize: 0,
				checksumSha256: null,
				folderId: null,
			},
		});
		assert.equal(response.status, 400, `upload 0 byte phải 400, nhận ${response.status}`);
	});

	it(
		'multipart: tổng bytes khai báo lệch với object thật phải bị từ chối',
		{
			// s3rver (storage local) KHÔNG implement ListParts (GET trên uploadId → 405)
			// ⇒ không kiểm chứng được ở tầng HTTP. Regression test tầng app nằm ở
			// apps/api/test/upload-multipart-integrity.test.ts (MockObjectStorage).
			skip: 'storage local (s3rver) không hỗ trợ ListParts ⇒ BLOCKED ở tầng HTTP',
		},
		async () => {
			const declared = 101 * MB;
			const session = await createUploadSession(`fa-mp-${Date.now()}.bin`, declared);
			assert.equal(session.mode, 'multipart', 'file >100MB phải dùng multipart');

			const parts: Array<{ partNumber: number; etag: string; size: number }> = [];
			for (let partNumber = 1; partNumber <= session.partCount; partNumber += 1) {
				const query = new URLSearchParams({
					partNumber: String(partNumber),
					uploadId: session.uploadId ?? '',
				});
				const put = await client.request(
					`/uploads/${session.uploadSessionId}/content?${query.toString()}`,
					{
						method: 'POST',
						body: new Uint8Array([1]),
						headers: { 'content-type': 'application/octet-stream' },
					},
				);
				assert.equal(put.status, 200, `upload part ${partNumber} thất bại: ${put.status}`);
				parts.push({ partNumber, etag: put.headers.get('etag') ?? 'etag-unknown', size: 1 });
			}

			const complete = await client.call(`/uploads/${session.uploadSessionId}/complete`, {
				method: 'POST',
				json: { parts, uploadId: session.uploadId, checksumSha256: null },
			});
			assert.equal(
				complete.status,
				400,
				`multipart lệch tổng bytes phải 400, nhận ${complete.status}: ${JSON.stringify(complete.body)}`,
			);
		},
	);

	it('abort upload ⇒ session bị huỷ và quota được hoàn lại', async () => {
		const before = await client.call<{ reservedBytes: number }>('/system/usage');
		const session = await createUploadSession(`fa-abort-${Date.now()}.bin`, 5 * MB);
		const during = await client.call<{ reservedBytes: number }>('/system/usage');
		assert.ok(
			during.body.reservedBytes >= before.body.reservedBytes + 5 * MB,
			`phải giữ chỗ quota khi upload đang dở: ${during.body.reservedBytes}`,
		);

		const abort = await client.call(`/uploads/${session.uploadSessionId}`, { method: 'DELETE' });
		assert.equal(abort.status, 200, `abort thất bại: ${JSON.stringify(abort.body)}`);

		const after = await client.call<{ reservedBytes: number }>('/system/usage');
		assert.equal(
			after.body.reservedBytes,
			before.body.reservedBytes,
			`abort phải hoàn quota: ${after.body.reservedBytes} != ${before.body.reservedBytes}`,
		);
	});

	it('Idempotency-Key: cùng payload ⇒ replay session, payload khác ⇒ 409', async () => {
		const key = `fa-idem-${Date.now()}`;
		const payload = {
			fileName: `fa-idem-file-${Date.now()}.txt`,
			contentType: 'text/plain',
			totalSize: 4,
			checksumSha256: null,
			folderId: null,
		};
		const first = await client.call<UploadSession>('/uploads', {
			method: 'POST',
			json: payload,
			headers: { 'idempotency-key': key },
		});
		assert.equal(first.status, 201);
		const replay = await client.call<UploadSession>('/uploads', {
			method: 'POST',
			json: payload,
			headers: { 'idempotency-key': key },
		});
		assert.equal(replay.status, 201, `replay phải trả 201, nhận ${replay.status}`);
		assert.equal(replay.body.uploadSessionId, first.body.uploadSessionId);

		const conflict = await client.call('/uploads', {
			method: 'POST',
			json: { ...payload, fileName: 'khac.txt' },
			headers: { 'idempotency-key': key },
		});
		assert.equal(conflict.status, 409, `payload khác phải 409, nhận ${conflict.status}`);
	});
});

describe('functional audit — shares', { skip: SKIP }, () => {
	before(async () => {
		if (!client) await ensureSession();
	});

	it('share có mật khẩu: info che metadata, unlock sai 403, unlock đúng tải được', async () => {
		const payload = new TextEncoder().encode('share-secret-content');
		const file = await uploadFile(`fa-share-${Date.now()}.txt`, payload, { contentType: 'text/plain' });
		const sharePassword = 'share-pass-1234';
		const created = await client.call<{ share: { id: string }; token: string }>('/shares', {
			method: 'POST',
			json: {
				fileId: file.id,
				expiresInDays: 1,
				maxDownloads: 5,
				passwordVerifier: shareVerifier(sharePassword),
				passwordSalt: 'fa-share-salt',
				passwordParams: 'sha-256-v1',
			},
		});
		assert.equal(created.status, 201, `tạo share thất bại: ${JSON.stringify(created.body)}`);
		const token = created.body.token;

		const info = await client.call<{ share: { fileName: string | null } }>('/public/share/info', {
			headers: { 'x-share-token': token },
		});
		assert.equal(info.status, 200);
		assert.equal(info.body.share.fileName, null, 'share có mật khẩu không được lộ tên file');

		const wrong = await client.call('/public/share/unlock', {
			method: 'POST',
			json: { passwordVerifier: shareVerifier('wrong-password') },
			headers: { 'x-share-token': token },
		});
		assert.equal(wrong.status, 403, `unlock sai phải 403, nhận ${wrong.status}`);

		const unlock = await client.call<{ grant: string }>('/public/share/unlock', {
			method: 'POST',
			json: { passwordVerifier: shareVerifier(sharePassword) },
			headers: { 'x-share-token': token },
		});
		assert.equal(unlock.status, 200, `unlock đúng phải 200, nhận ${unlock.status}`);

		const download = await client.request('/public/share/download', {
			headers: { 'x-share-token': token, 'x-share-grant': unlock.body.grant },
		});
		assert.equal(download.status, 200);
		assert.equal(await download.text(), 'share-secret-content');
	});

	it('share hết maxDownloads ⇒ lần tải sau bị 403', async () => {
		const file = await uploadFile(`fa-share-max-${Date.now()}.txt`, new TextEncoder().encode('once'));
		const created = await client.call<{ token: string }>('/shares', {
			method: 'POST',
			json: {
				fileId: file.id,
				expiresInDays: 1,
				maxDownloads: 1,
				passwordVerifier: null,
				passwordSalt: null,
				passwordParams: null,
			},
		});
		assert.equal(created.status, 201);
		const token = created.body.token;
		const first = await client.request('/public/share/download', {
			headers: { 'x-share-token': token },
		});
		assert.equal(first.status, 200);
		await first.text();
		const second = await client.request('/public/share/download', {
			headers: { 'x-share-token': token },
		});
		assert.equal(second.status, 403, `vượt maxDownloads phải 403, nhận ${second.status}`);
	});

	it('range không thỏa mãn ⇒ 416 và KHÔNG tiêu tốn lượt tải', async () => {
		const file = await uploadFile(`fa-share-range-${Date.now()}.txt`, new TextEncoder().encode('abcdefghij'));
		const created = await client.call<{ token: string }>('/shares', {
			method: 'POST',
			json: {
				fileId: file.id,
				expiresInDays: 1,
				maxDownloads: 2,
				passwordVerifier: null,
				passwordSalt: null,
				passwordParams: null,
			},
		});
		assert.equal(created.status, 201);
		const token = created.body.token;
		const bad = await client.request('/public/share/download', {
			headers: { 'x-share-token': token, range: 'bytes=500-600' },
		});
		assert.equal(bad.status, 416, `range ngoài giới hạn phải 416, nhận ${bad.status}`);
		await bad.text();
		const good = await client.request('/public/share/download', {
			headers: { 'x-share-token': token },
		});
		assert.equal(good.status, 200, `lượt tải phải còn nguyên sau 416, nhận ${good.status}`);
		await good.text();
	});
});

describe('functional audit — system', { skip: SKIP }, () => {
	before(async () => {
		if (!client) await ensureSession();
	});

	it('/system/usage khớp tổng dung lượng file đang hoạt động', async () => {
		const payload = new TextEncoder().encode('usage-probe');
		const file = await uploadFile(`fa-usage-${Date.now()}.txt`, payload);
		const usage = await client.call<{ usedBytes: number; quotaBytes: number }>('/system/usage');
		assert.equal(usage.status, 200);
		assert.ok(usage.body.quotaBytes > 0);
		assert.ok(
			usage.body.usedBytes >= file.size,
			`usedBytes ${usage.body.usedBytes} phải >= size file ${file.size}`,
		);
	});

	it('/system/audit với limit không nguyên ⇒ 400 (không phải 500)', async () => {
		const response = await client.call('/system/audit?limit=1.5');
		assert.equal(response.status, 400, `limit=1.5 phải 400, nhận ${response.status}`);
	});

	it('/system/diagnostics trả 200', async () => {
		const response = await client.call('/system/diagnostics');
		assert.equal(response.status, 200);
	});
});
