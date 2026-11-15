/** Client API cho AlkCloud. */

/**
 * Base URL của API.
 *
 * `import.meta.env` chỉ tồn tại khi Vite build. Khi chạy test bằng `node --test`
 * (không qua Vite) `import.meta.env` là `undefined` ⇒ phải guard để không ném
 * TypeError lúc import module.
 */
const viteEnv = (import.meta as { env?: Record<string, string | undefined> }).env ?? {};

/**
 * Base URL API mặc định khi build production.
 *
 * Web chạy ở `cloud.alk.xx.kg`, API ở `api.alk.xx.kg` ⇒ KHÔNG dùng được
 * relative path `/api/v1` (Worker web trả SPA fallback `text/html` ⇒ fetch
 * `.json()` ném lỗi ⇒ UI tưởng "chưa khởi tạo"). Giá trị này là nguồn sự
 * thật duy nhất trong source; `VITE_ALKCLOUD_API_URL` vẫn ghi đè được khi
 * deploy sang domain khác.
 */
const DEFAULT_PRODUCTION_API_BASE = 'https://api.alk.xx.kg/api/v1';

const isProductionBuild = (import.meta as { env?: Record<string, unknown> }).env?.PROD === true;

export const API_BASE =
	viteEnv.VITE_ALKCLOUD_API_URL ?? (isProductionBuild ? DEFAULT_PRODUCTION_API_BASE : '/api/v1');

export interface ApiErrorBody {
	error?: { code?: string; message?: string; details?: unknown };
}

export class ApiError extends Error {
	constructor(
		readonly status: number,
		readonly code: string,
		message: string,
		readonly details?: unknown,
	) {
		super(message);
		this.name = 'ApiError';
	}
}

let csrfToken: string | null = null;

export function setCsrfToken(token: string | null): void {
	csrfToken = token;
}

export function getCsrfToken(): string | null {
	return csrfToken;
}

export interface RequestOptions {
	method?: string;
	body?: unknown;
	headers?: Record<string, string>;
	signal?: AbortSignal;
}

export async function apiRequest<T = unknown>(path: string, options: RequestOptions = {}): Promise<T> {
	const method = options.method ?? 'GET';
	const headers: Record<string, string> = {
		...options.headers,
	};
	if (options.body !== undefined) headers['content-type'] = 'application/json';
	if (csrfToken && method !== 'GET' && method !== 'HEAD') headers['x-alkcloud-csrf'] = csrfToken;

	const response = await fetch(`${API_BASE}${path}`, {
		method,
		headers,
		credentials: 'include',
		body: options.body === undefined ? undefined : JSON.stringify(options.body),
		signal: options.signal,
	});

	if (response.status === 204) return undefined as T;

	const text = await response.text();
	let payload: unknown = null;
	let parsedAsJson = false;
	if (text) {
		try {
			payload = JSON.parse(text);
			parsedAsJson = true;
		} catch {
			payload = text;
		}
	}

	// API phải trả JSON. Nếu HTTP OK nhưng body là HTML (SPA fallback, trang lỗi
	// proxy…) thì caller sẽ parse `undefined` và chết trong im lặng — báo rõ
	// ngay thay vì để lỗi lan truyền.
	if (response.ok && text && !parsedAsJson) {
		throw new ApiError(
			response.status,
			'invalid_response',
			'API trả về nội dung không phải JSON — kiểm tra cấu hình API_BASE (VITE_ALKCLOUD_API_URL).',
		);
	}

	if (!response.ok) {
		const body = payload as ApiErrorBody;
		throw new ApiError(
			response.status,
			body?.error?.code ?? 'unknown',
			body?.error?.message ?? `HTTP ${response.status}`,
			body?.error?.details,
		);
	}
	return payload as T;
}

// ------------------------------------------------------------------ types

export interface Owner {
	id: string;
	email: string;
}

export interface SessionInfo {
	id: string;
	csrfToken: string;
	expiresAt: string;
}

export interface FileEntry {
	id: string;
	name: string;
	size: number;
	contentType: string;
	createdAt: string;
	updatedAt: string;
	deletedAt: string | null;
	purgeAfter: string | null;
	folderId: string | null;
}

export interface FolderEntry {
	id: string;
	parentId: string | null;
	name: string;
	depth: number;
	createdAt: string;
	/** Chỉ có trong response của GET /folders/trash. */
	deletedAt?: string | null;
}

export interface ShareEntry {
	id: string;
	fileId: string;
	expiresAt: string;
	maxDownloads: number | null;
	downloadCount: number;
	revokedAt: string | null;
	hasPassword: boolean;
	createdAt: string;
}

export interface QuotaModeResponse {
	mode: 'NORMAL' | 'CONSERVE' | 'READ_ONLY' | 'EMERGENCY';
	utilizationAccount?: number;
	utilizationBudget?: number;
	updatedAt?: string;
}

export interface UploadSessionResponse {
	uploadSessionId: string;
	mode: 'single' | 'multipart';
	uploadId?: string;
	partSize: number;
	partCount: number;
	parts: { partNumber: number; url: string; headers?: Record<string, string>; expiresAt: string }[];
}

// ------------------------------------------------------------------ auth

/**
 * Lấy salt + params Argon2id đã lưu của owner.
 * Client PHẢI dùng đúng salt này để dẫn xuất lại `authKey` giống lúc đăng ký.
 */
export async function getAuthParams(): Promise<{ salt: string; params: string }> {
	return apiRequest('/auth/params');
}

export async function getAuthStatus(): Promise<{
	bootstrapped: boolean;
	email: string | null;
	turnstileEnabled: boolean;
}> {
	return apiRequest('/auth/status');
}

export async function login(email: string, authKey: string): Promise<{ owner: Owner; session: SessionInfo }> {
	const result = await apiRequest<{ owner: Owner; session: SessionInfo }>('/auth/login', {
		method: 'POST',
		body: { email, authKey },
	});
	setCsrfToken(result.session.csrfToken);
	return result;
}

export async function recoveryLogin(email: string, code: string): Promise<{ owner: Owner; session: SessionInfo }> {
	const result = await apiRequest<{ owner: Owner; session: SessionInfo }>('/auth/recovery-login', {
		method: 'POST',
		body: { email, code },
	});
	setCsrfToken(result.session.csrfToken);
	return result;
}

export async function bootstrap(input: {
	setupToken: string;
	email: string;
	authKey: string;
	authVerifierSalt: string;
	authParams: string;
}): Promise<{ owner: Owner; session: SessionInfo; recoveryCodes: string[] }> {
	const result = await apiRequest<{ owner: Owner; session: SessionInfo; recoveryCodes: string[] }>(
		'/auth/bootstrap',
		{ method: 'POST', body: input },
	);
	setCsrfToken(result.session.csrfToken);
	return result;
}

export async function getSession(): Promise<{
	owner: Owner | null;
	session: SessionInfo;
	recoveryCodesRemaining: number;
}> {
	const result = await apiRequest<{
		owner: Owner | null;
		session: SessionInfo;
		recoveryCodesRemaining: number;
	}>('/auth/session');
	setCsrfToken(result.session.csrfToken);
	return result;
}

export async function logout(): Promise<void> {
	await apiRequest('/auth/logout', { method: 'POST', body: {} });
	setCsrfToken(null);
}

export async function changePassword(input: {
	currentAuthKey: string;
	newAuthKey: string;
	newAuthVerifierSalt: string;
	newAuthParams: string;
}): Promise<{ recoveryCodes: string[] }> {
	return apiRequest('/auth/password', { method: 'POST', body: input });
}

export async function listSessions(): Promise<{
	sessions: {
		id: string;
		createdAt: string;
		lastSeenAt: string;
		expiresAt: string;
		revokedAt: string | null;
		userAgent: string | null;
		current: boolean;
	}[];
}> {
	return apiRequest('/auth/sessions');
}

export async function regenerateRecoveryCodes(): Promise<{ recoveryCodes: string[] }> {
	return apiRequest('/auth/recovery-codes/regenerate', { method: 'POST', body: {} });
}

export async function revokeSession(id: string): Promise<void> {
	await apiRequest(`/auth/sessions/${encodeURIComponent(id)}`, { method: 'DELETE' });
}

// ------------------------------------------------------------------ files

export async function listFiles(params: {
	parentId?: string | null;
	q?: string;
	trashed?: boolean;
	cursor?: string;
}): Promise<{ files: FileEntry[]; mode: string; nextCursor: string | null }> {
	const query = new URLSearchParams();
	if (params.parentId) query.set('parentId', params.parentId);
	if (params.q) query.set('q', params.q);
	if (params.trashed) query.set('trashed', 'true');
	if (params.cursor) query.set('cursor', params.cursor);
	const suffix = query.toString();
	return apiRequest(`/files${suffix ? `?${suffix}` : ''}`);
}

/**
 * Tải TOÀN BỘ file khớp điều kiện bằng cách lần theo `nextCursor`.
 *
 * API mặc định trả 100 file/trang; nếu chỉ gọi 1 lần thì file thứ 101 trở đi
 * **không bao giờ hiện** trong UI (trước đây web bị giới hạn cứng 100 file).
 */
export async function listFilesAll(params: {
	parentId?: string | null;
	q?: string;
	trashed?: boolean;
}): Promise<{ files: FileEntry[]; mode: string }> {
	const files: FileEntry[] = [];
	let cursor: string | undefined;
	let mode = 'NORMAL';
	// Trần 50 trang = 5000 file: đủ cho mọi thư mục hợp lý và tránh vòng lặp
	// vô hạn nếu API trả cursor lỗi.
	for (let page = 0; page < 50; page += 1) {
		const result = await listFiles({ ...params, cursor });
		files.push(...result.files);
		mode = result.mode;
		if (!result.nextCursor) break;
		cursor = result.nextCursor;
	}
	return { files, mode };
}

export async function listFolders(parentId?: string | null): Promise<{ folders: FolderEntry[] }> {
	const suffix = parentId ? `?parentId=${encodeURIComponent(parentId)}` : '';
	return apiRequest(`/folders${suffix}`);
}

export async function createFolder(name: string, parentId: string | null): Promise<{ folder: FolderEntry }> {
	return apiRequest('/folders', { method: 'POST', body: { name, parentId } });
}

export async function moveFolder(id: string, parentId: string | null): Promise<void> {
	await apiRequest(`/folders/${encodeURIComponent(id)}/move`, { method: 'POST', body: { parentId } });
}

export async function renameFolder(id: string, name: string): Promise<void> {
	await apiRequest(`/folders/${encodeURIComponent(id)}`, { method: 'PATCH', body: { name } });
}

export async function deleteFolder(id: string): Promise<void> {
	await apiRequest(`/folders/${encodeURIComponent(id)}`, { method: 'DELETE' });
}

export async function renameFile(id: string, name: string): Promise<void> {
	await apiRequest(`/files/${encodeURIComponent(id)}`, { method: 'PATCH', body: { name } });
}

export async function moveFile(id: string, folderId: string | null): Promise<void> {
	await apiRequest(`/files/${encodeURIComponent(id)}/move`, { method: 'POST', body: { folderId } });
}

export async function deleteFile(id: string): Promise<void> {
	await apiRequest(`/files/${encodeURIComponent(id)}`, { method: 'DELETE' });
}

export async function restoreFile(id: string): Promise<void> {
	await apiRequest(`/files/${encodeURIComponent(id)}/restore`, { method: 'POST', body: {} });
}

export async function purgeFile(id: string): Promise<void> {
	await apiRequest(`/files/${encodeURIComponent(id)}/purge`, { method: 'DELETE' });
}

export async function purgeFolder(id: string): Promise<void> {
	await apiRequest(`/folders/${encodeURIComponent(id)}/purge`, { method: 'DELETE' });
}

export async function listTrash(): Promise<{ files: FileEntry[]; retentionDays: number }> {
	return apiRequest('/files/trash');
}

export async function listTrashFolders(): Promise<{ folders: FolderEntry[]; retentionDays: number }> {
	return apiRequest('/folders/trash');
}

export async function restoreFolder(id: string): Promise<void> {
	await apiRequest(`/folders/${encodeURIComponent(id)}/restore`, { method: 'POST', body: {} });
}

export async function openFileUrl(id: string): Promise<{ url: string; expiresAt: string; size: number }> {
	return apiRequest(`/files/${encodeURIComponent(id)}/open`);
}

/**
 * URL tải file qua Worker proxy — giữ đúng tên file gốc (`content-disposition`).
 * Dùng cho file vừa/nhỏ; file lớn nên dùng presigned URL để tránh timeout proxy.
 */
export function fileDownloadUrl(id: string): string {
	return `${API_BASE}/files/${encodeURIComponent(id)}/download`;
}

// ------------------------------------------------------------------ uploads

export async function createUploadSession(input: {
	fileName: string;
	contentType: string;
	totalSize: number;
	checksumSha256?: string | null;
	folderId?: string | null;
}): Promise<UploadSessionResponse> {
	return apiRequest('/uploads', { method: 'POST', body: { ...input, checksumSha256: input.checksumSha256 ?? null } });
}

export async function presignUploadParts(
	uploadSessionId: string,
	uploadId: string,
	partNumbers: number[],
): Promise<{ parts: UploadSessionResponse['parts'] }> {
	return apiRequest(`/uploads/${encodeURIComponent(uploadSessionId)}/parts`, {
		method: 'POST',
		body: { uploadId, partNumbers },
	});
}

/**
 * PUT nội dung part qua API.
 *
 * Browser KHÔNG PUT thẳng vào presigned URL của B2: CSP do Cloudflare edge đặt
 * có thể không khai báo host B2 trong `connect-src` ⇒ fetch bị chặn ⇒
 * "Failed to fetch". API nhận body rồi chuyển tiếp qua relay tới B2 (2-hop).
 *
 * Client KHÔNG gửi presigned URL (bearer credential) — API tự ký target từ
 * session. Multipart chỉ cần `partNumber` + `uploadId` (không đủ để PUT vào B2
 * khi thiếu secret key).
 */
export async function uploadContent(
	uploadSessionId: string,
	params: { partNumber?: number; uploadId?: string },
	body: Blob,
	headers: Record<string, string> = {},
	signal?: AbortSignal,
): Promise<Response> {
	const query = new URLSearchParams();
	if (params.partNumber !== undefined) query.set('partNumber', String(params.partNumber));
	if (params.uploadId) query.set('uploadId', params.uploadId);
	const suffix = query.size > 0 ? `?${query.toString()}` : '';
	// Dùng **POST** (không phải PUT): `Access-Control-Allow-Methods` ở Cloudflare edge
	// không có PUT ⇒ Chrome chặn request thật ngay sau preflight (preflight 204 OK nhưng
	// browser không gửi ⇒ "Failed to fetch"). POST nằm trong allow-list.
	return fetch(`${API_BASE}/uploads/${encodeURIComponent(uploadSessionId)}/content${suffix}`, {
		method: 'POST',
		headers: {
			...headers,
			...(csrfToken ? { 'x-alkcloud-csrf': csrfToken } : {}),
		},
		body,
		credentials: 'include',
		signal,
	});
}

export async function completeUpload(
	uploadSessionId: string,
	input: { uploadId?: string; parts: { partNumber: number; etag: string; size: number }[] },
): Promise<{ file: FileEntry }> {
	return apiRequest(`/uploads/${encodeURIComponent(uploadSessionId)}/complete`, {
		method: 'POST',
		body: { ...input, checksumSha256: null },
	});
}

export async function abortUpload(uploadSessionId: string, uploadId?: string): Promise<void> {
	await apiRequest(`/uploads/${encodeURIComponent(uploadSessionId)}`, {
		method: 'DELETE',
		body: uploadId ? { uploadId } : {},
	});
}

// ------------------------------------------------------------------ shares

export async function listShares(fileId: string): Promise<{ shares: ShareEntry[] }> {
	return apiRequest(`/shares?fileId=${encodeURIComponent(fileId)}`);
}

export async function createShare(input: {
	fileId: string;
	expiresInDays?: number;
	maxDownloads?: number | null;
	passwordVerifier?: string | null;
	passwordSalt?: string | null;
	passwordParams?: string | null;
}): Promise<{ share: ShareEntry; url: string; token: string }> {
	return apiRequest('/shares', { method: 'POST', body: input });
}

export async function revokeShare(id: string): Promise<void> {
	await apiRequest(`/shares/${encodeURIComponent(id)}`, { method: 'DELETE' });
}

// ------------------------------------------------------------------ system

export async function getQuota(): Promise<QuotaModeResponse> {
	return apiRequest('/system/quota');
}

export async function getUsage(): Promise<{
	quotaBytes: number;
	usedBytes: number;
	reservedBytes: number;
}> {
	return apiRequest('/system/usage');
}
