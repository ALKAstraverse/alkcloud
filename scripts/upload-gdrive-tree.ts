#!/usr/bin/env node
/**
 * Upload cây thư mục tải từ Google Drive lên AlkCloud production.
 *
 * - Credential đọc từ `deploy/production-secrets.env` (mode 600) — KHÔNG in.
 * - Protocol đúng như client web: POST /uploads → PUT presigned → POST complete.
 * - Tạo thư mục theo cây, tự tránh trùng tên file (Nextcloud-style).
 * - Có retry + bỏ qua file đã upload (idempotent theo tên trong thư mục đích).
 */
import { readFileSync, existsSync, statSync, openSync, readSync, closeSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { deriveAuthKey } from './lib/auth-key.js';

const API = process.env.ALKCLOUD_API_URL ?? 'https://api.alk.xx.kg/api/v1';
const ORIGIN = process.env.ALKCLOUD_ORIGIN ?? 'https://cloud.alk.xx.kg';
const SECRETS_FILE = resolve(process.env.ALKCLOUD_SECRETS_FILE ?? 'deploy/production-secrets.env');
const MANIFEST = '/tmp/opencode/gdrive-manifest.json';
const LOCAL_ROOT = '/tmp/opencode/gdrive-download';

function readEnvFile(path: string): Record<string, string> {
	const out: Record<string, string> = {};
	if (!existsSync(path)) return out;
	for (const line of readFileSync(path, 'utf8').split('\n')) {
		const trimmed = line.trim();
		if (!trimmed || trimmed.startsWith('#')) continue;
		const index = trimmed.indexOf('=');
		if (index === -1) continue;
		out[trimmed.slice(0, index)] = trimmed.slice(index + 1);
	}
	return out;
}

const env = readEnvFile(SECRETS_FILE);
const email = env.OWNER_EMAIL;
const password = env.OWNER_PASSWORD;
if (!email || !password) throw new Error('Thiếu OWNER_EMAIL / OWNER_PASSWORD');

let cookie = '';
let csrf = '';

async function api<T>(path: string, options: { method?: string; body?: unknown; raw?: Buffer } = {}): Promise<T> {
	const method = options.method ?? 'GET';
	const headers: Record<string, string> = { origin: ORIGIN };
	if (cookie) headers.cookie = cookie;
	if (csrf && method !== 'GET' && method !== 'HEAD') headers['x-alkcloud-csrf'] = csrf;
	let body: string | Buffer | undefined;
	if (options.raw) {
		body = options.raw;
		headers['content-type'] = 'application/octet-stream';
	} else if (options.body !== undefined) {
		body = JSON.stringify(options.body);
		headers['content-type'] = 'application/json';
	}
	const response = await fetch(`${API}${path}`, { method, headers, body });
	const setCookie = response.headers.get('set-cookie');
	if (setCookie) cookie = setCookie.split(';')[0]!;
	const text = await response.text();
	if (!response.ok) {
		let message = text.slice(0, 200);
		try {
			const parsed = JSON.parse(text) as { error?: { message?: string; code?: string } };
			message = parsed.error?.message ?? parsed.error?.code ?? message;
		} catch {
			/* giữ message thô */
		}
		throw new Error(`HTTP ${response.status} ${path} — ${message}`);
	}
	if (!text) return undefined as T;
	return JSON.parse(text) as T;
}

async function login(): Promise<void> {
	const params = await api<{ salt: string; params: string }>('/auth/params');
	const authKey = await deriveAuthKey(password!, params.salt, params.params ?? '');
	const result = await api<{ session: { csrfToken: string } }>('/auth/login', {
		method: 'POST',
		body: { email, authKey },
	});
	csrf = result.session.csrfToken;
	console.log('đăng nhập production: OK');
}

interface FolderEntry {
	id: string;
	name: string;
	parentId: string | null;
}
interface FileEntry {
	id: string;
	name: string;
	size: number;
	folderId: string | null;
}

async function listFolders(parentId: string | null): Promise<FolderEntry[]> {
	const suffix = parentId ? `?parentId=${encodeURIComponent(parentId)}` : '';
	const result = await api<{ folders: FolderEntry[] }>(`/folders${suffix}`);
	return result.folders;
}

async function listFiles(folderId: string | null): Promise<FileEntry[]> {
	const suffix = folderId ? `?parentId=${encodeURIComponent(folderId)}` : '';
	const result = await api<{ files: FileEntry[] }>(`/files${suffix}`);
	return result.files;
}

async function ensureFolder(name: string, parentId: string | null): Promise<string> {
	const existing = await listFolders(parentId);
	const found = existing.find((f) => f.name.trim().toLowerCase() === name.trim().toLowerCase());
	if (found) return found.id;
	const created = await api<{ folder: FolderEntry }>('/folders', {
		method: 'POST',
		body: { name, parentId },
	});
	return created.folder.id;
}

function uniqueName(name: string, taken: Set<string>): string {
	const lower = (s: string) => s.toLowerCase();
	if (!taken.has(lower(name))) return name;
	const dot = name.lastIndexOf('.');
	const stem = dot > 0 ? name.slice(0, dot) : name;
	const ext = dot > 0 ? name.slice(dot) : '';
	for (let index = 1; index < 1000; index += 1) {
		const candidate = `${stem} (${index})${ext}`;
		if (!taken.has(lower(candidate))) return candidate;
	}
	return `${stem} (${Date.now()})${ext}`;
}

interface UploadSession {
	uploadSessionId: string;
	mode: 'single' | 'multipart';
	uploadId?: string;
	partSize: number;
	partCount: number;
	parts: { partNumber: number; url: string; headers?: Record<string, string> }[];
}

async function putPart(
	sessionId: string,
	target: string,
	headers: Record<string, string> | undefined,
	chunk: Buffer,
	part: { partNumber: number; uploadId?: string },
): Promise<string> {
	let response = await fetch(target, { method: 'PUT', headers: headers ?? {}, body: chunk });
	let etag = response.ok ? (response.headers.get('etag') ?? '') : '';
	if (!response.ok || etag === '') {
		// fallback qua API (API → relay → B2)
		const query = new URLSearchParams();
		query.set('partNumber', String(part.partNumber));
		if (part.uploadId) query.set('uploadId', part.uploadId);
		const proxyHeaders: Record<string, string> = { origin: ORIGIN, cookie, 'x-alkcloud-csrf': csrf };
		response = await fetch(`${API}/uploads/${encodeURIComponent(sessionId)}/content?${query}`, {
			method: 'PUT',
			headers: proxyHeaders,
			body: chunk,
		});
		if (!response.ok) throw new Error(`PUT part thất bại (${response.status})`);
		etag = response.headers.get('etag') ?? '';
	}
	return etag.replace(/^"|"$/g, '');
}

async function uploadFile(filePath: string, fileName: string, size: number, folderId: string | null): Promise<void> {
	const contentType = guessType(fileName);
	const session = await api<UploadSession>('/uploads', {
		method: 'POST',
		body: { fileName, contentType, totalSize: size, folderId, checksumSha256: null },
	});
	const fd = openSync(filePath, 'r');
	try {
		if (session.mode === 'single') {
			const part = session.parts[0]!;
			const buffer = Buffer.allocUnsafe(size);
			readSync(fd, buffer, 0, size, 0);
			const etag = await putPart(session.uploadSessionId, part.url, part.headers, buffer, { partNumber: 1 });
			await api(`/uploads/${encodeURIComponent(session.uploadSessionId)}/complete`, {
				method: 'POST',
				body: { parts: [{ partNumber: 1, etag, size }] },
			});
			return;
		}
		const uploadId = session.uploadId!;
		const parts: { partNumber: number; etag: string; size: number }[] = [];
		const numbers = Array.from({ length: session.partCount }, (_, i) => i + 1);
		for (let offset = 0; offset < numbers.length; offset += 20) {
			const batch = numbers.slice(offset, offset + 20);
			const presigned = await api<{ parts: UploadSession['parts'] }>(
				`/uploads/${encodeURIComponent(session.uploadSessionId)}/parts`,
				{ method: 'POST', body: { uploadId, partNumbers: batch } },
			);
			for (const target of presigned.parts) {
				const start = (target.partNumber - 1) * session.partSize;
				const length = Math.min(session.partSize, size - start);
				const chunk = Buffer.allocUnsafe(length);
				readSync(fd, chunk, 0, length, start);
				const etag = await putPart(session.uploadSessionId, target.url, target.headers, chunk, {
					partNumber: target.partNumber,
					uploadId,
				});
				parts.push({ partNumber: target.partNumber, etag, size: length });
			}
		}
		parts.sort((a, b) => a.partNumber - b.partNumber);
		await api(`/uploads/${encodeURIComponent(session.uploadSessionId)}/complete`, {
			method: 'POST',
			body: { uploadId, parts },
		});
	} finally {
		closeSync(fd);
	}
}

const GDOC_EXT: Record<string, string> = { document: 'docx', spreadsheet: 'xlsx', presentation: 'pptx' };
const MIME: Record<string, string> = {
	pdf: 'application/pdf',
	doc: 'application/msword',
	docx: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
	xls: 'application/vnd.ms-excel',
	xlsx: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
	ppt: 'application/vnd.ms-powerpoint',
	pptx: 'application/vnd.openxmlformats-officedocument.presentationml.presentation',
	zip: 'application/zip',
	rar: 'application/vnd.rar',
	'7z': 'application/x-7z-compressed',
	jpg: 'image/jpeg',
	jpeg: 'image/jpeg',
	png: 'image/png',
	gif: 'image/gif',
	txt: 'text/plain',
	csv: 'text/csv',
	mp4: 'video/mp4',
	mp3: 'audio/mpeg',
};
function guessType(name: string): string {
	const dot = name.lastIndexOf('.');
	if (dot < 0) return 'application/octet-stream';
	return MIME[name.slice(dot + 1).toLowerCase()] ?? 'application/octet-stream';
}

async function main(): Promise<void> {
	await login();
	const manifest = JSON.parse(await readFile(MANIFEST, 'utf8')) as {
		root: string;
		items: { id: string; name: string; type: string; path: string }[];
	};

	// 1) Tạo cây thư mục
	const folderIdByPath = new Map<string, string>();
	const rootId = await ensureFolder(manifest.root, null);
	folderIdByPath.set('', rootId);
	console.log(`thư mục gốc "${manifest.root}" → ${rootId}`);

	const folders = manifest.items.filter((i) => i.type === 'folder');
	// Manifest: với item folder, `path` = path của thư mục CHA (không gồm tên).
	// Sắp xếp theo độ sâu để cha luôn có trước con.
	folders.sort((a, b) => a.path.split('/').length - b.path.split('/').length);
	for (const folder of folders) {
		const parentPath = folder.path;
		const parentId = folderIdByPath.get(parentPath) ?? rootId;
		const id = await ensureFolder(folder.name, parentId);
		const fullPath = parentPath ? `${parentPath}/${folder.name}` : folder.name;
		folderIdByPath.set(fullPath, id);
	}
	console.log(`đã đảm bảo ${folders.length} thư mục con`);

	// 2) Upload tệp
	const files = manifest.items.filter((i) => i.type !== 'folder');
	const results: { name: string; path: string; status: string; error?: string }[] = [];
	const takenByFolder = new Map<string, Set<string>>();
	const existingByFolder = new Map<string, Map<string, number>>();
	for (const [folderPath, id] of folderIdByPath) {
		const existing = await listFiles(id);
		takenByFolder.set(id, new Set(existing.map((f) => f.name.toLowerCase())));
		existingByFolder.set(id, new Map(existing.map((f) => [f.name.toLowerCase(), f.size])));
	}

	for (const [index, file] of files.entries()) {
		const folderId = folderIdByPath.get(file.path) ?? rootId;
		// Tệp Google Docs native đã export ra docx/xlsx/pptx ⇒ thêm đuôi khi tải cục bộ.
		const localName = file.type.startsWith('gdoc')
			? `${file.name}.${GDOC_EXT[file.type.split(':')[1]!] ?? 'pdf'}`
			: file.name;
		const localPath = join(LOCAL_ROOT, file.path, localName);
		if (!existsSync(localPath)) {
			results.push({ name: file.name, path: file.path, status: 'missing' });
			continue;
		}
		const size = statSync(localPath).size;
		const taken = takenByFolder.get(folderId)!;
		const existingMap = existingByFolder.get(folderId)!;
		// Đã có đúng tên + đúng kích thước ⇒ bỏ qua (resume, không nhân bản).
		if (existingMap.get(file.name.toLowerCase()) === size) {
			results.push({ name: file.name, path: file.path, status: 'skipped' });
			console.log(`[${index + 1}/${files.length}] SKIP ${(size / 1e6).toFixed(2)} MB  ${file.path}/${file.name} (đã có)`);
			continue;
		}
		const finalName = uniqueName(file.name, taken);
		taken.add(finalName.toLowerCase());
		let done = false;
		let lastError = '';
		for (let attempt = 1; attempt <= 3 && !done; attempt += 1) {
			try {
				await uploadFile(localPath, finalName, size, folderId);
				done = true;
			} catch (error) {
				lastError = error instanceof Error ? error.message : String(error);
				await new Promise((r) => setTimeout(r, 4000 * attempt));
			}
		}
		results.push({ name: finalName, path: file.path, status: done ? 'ok' : 'failed', error: done ? undefined : lastError });
		console.log(
			`[${index + 1}/${files.length}] ${done ? 'OK  ' : 'FAIL'} ${(size / 1e6).toFixed(2)} MB  ${file.path}/${finalName}${done ? '' : ` — ${lastError.slice(0, 120)}`}`,
		);
	}

	const failed = results.filter((r) => r.status === 'failed');
	const missing = results.filter((r) => r.status === 'missing');
	const skipped = results.filter((r) => r.status === 'skipped');
	console.log(
		`\nTỔNG: ok=${results.length - failed.length - missing.length - skipped.length} skipped=${skipped.length} failed=${failed.length} missing=${missing.length}`,
	);
	if (failed.length) console.log('FAILED:', JSON.stringify(failed, null, 1));
}

await main();
