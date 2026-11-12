import { AppError, isAppError, sha256Hex } from '@alkcloud/core';
import { StorageError } from '@alkcloud/storage';
import type { Context } from 'hono';
import { redactValue } from './redact.js';

export function json(body: unknown, status = 200, headers: Record<string, string> = {}): Response {
	return new Response(JSON.stringify(body), {
		status,
		headers: {
			'content-type': 'application/json; charset=utf-8',
			'cache-control': 'no-store',
			...headers,
		},
	});
}

/**
 * Encode tên file theo RFC 5987 (`filename*=UTF-8''...`).
 *
 * `encodeURIComponent` KHÔNG encode `!'()*` — các ký tự này không thuộc
 * `attr-char` của RFC 5987 nên phải encode tay, nếu không header
 * `Content-Disposition` không hợp lệ với một số client.
 */
export function encodeRfc5987(value: string): string {
	return encodeURIComponent(value).replace(/['()*]/g, (char) => `%${char.charCodeAt(0).toString(16).toUpperCase()}`);
}

export function noContent(headers: Record<string, string> = {}): Response {
	return new Response(null, { status: 204, headers });
}

export function errorResponse(error: unknown): Response {
	if (isAppError(error)) {
		return json(
			{ error: { code: error.code, message: error.message, details: error.details ?? null } },
			error.status,
			error.headers ?? {},
		);
	}
	// Lỗi lưu trữ (B2) hoặc circuit đang mở ⇒ 503 + `Retry-After` để client
	// biết đây là lỗi TẠM THỜI và có thể thử lại (không phải lỗi của client).
	// Không lộ message gốc (có thể chứa endpoint/chi tiết hạ tầng).
	if (error instanceof StorageError) {
		console.error(
			JSON.stringify({
				event: 'storage_error',
				at: new Date().toISOString(),
				status: error.status ?? null,
				code: error.code ?? null,
				error: redactValue(error),
			}),
		);
		const retryAfter =
			error.code === 'circuit_open' && 'retryAfterSeconds' in error
				? String((error as { retryAfterSeconds: number }).retryAfterSeconds)
				: '5';
		return json(
			{ error: { code: 'storage_unavailable', message: 'Dịch vụ lưu trữ tạm thời không khả dụng' } },
			503,
			{ 'retry-after': retryAfter },
		);
	}

	// Lỗi nội bộ (SQL, B2, runtime) KHÔNG được lộ message ra client —
	// message có thể chứa tên bảng, tên cột, endpoint hoặc chi tiết hạ tầng.
	// Chi tiết đầy đủ đã được ghi vào audit log / Workers Logs.
	// Log phải đi qua `redactValue` ⇒ URL ký S3, Bearer token, cookie không lọt
	// vào Workers Logs (retention 3 ngày, ai có quyền account cũng đọc được).
	console.error(
		JSON.stringify({
			event: 'unhandled_error',
			at: new Date().toISOString(),
			error: redactValue(error),
		}),
	);
	return json({ error: { code: 'internal_error', message: 'Lỗi nội bộ' } }, 500);
}

/**
 * Map lỗi ràng buộc DB thành AppError 409 thay vì 500.
 *
 * Unique index `idx_files_unique_name (folder_key, name_lower) WHERE deleted_at IS NULL`
 * ⇒ đổi tên / di chuyển / khôi phục trùng tên sẽ vi phạm ràng buộc.
 * Trả về lỗi 409 với thông báo rõ ràng thay vì lộ SQL ra ngoài.
 */
export function mapDbConflict(error: unknown, conflictMessage: string): never {
	const raw = error instanceof Error ? error.message : String(error);
	if (/UNIQUE constraint failed/i.test(raw)) {
		throw AppError.conflict(conflictMessage);
	}
	throw error;
}

const MAX_JSON_BODY_BYTES = 64 * 1024;

export async function parseJsonBody<T>(request: Request): Promise<T> {
	const contentType = request.headers.get('content-type') ?? '';
	if (!contentType.includes('application/json')) {
		throw AppError.badRequest('Content-Type phải là application/json');
	}
	// Kiểm tra Content-Length TRƯỚC khi đọc body: nếu đọc trước rồi mới check
	// thì attacker gửi body 100MB sẽ bị buffer vào RAM trước khi bị từ chối.
	const declaredLength = Number(request.headers.get('content-length') ?? '0');
	if (Number.isFinite(declaredLength) && declaredLength > MAX_JSON_BODY_BYTES) {
		throw new AppError('payload_too_large', 'body quá lớn');
	}
	let raw: string;
	try {
		raw = await request.text();
	} catch {
		throw AppError.badRequest('không đọc được body');
	}
	if (raw.length > MAX_JSON_BODY_BYTES) {
		throw new AppError('payload_too_large', 'body quá lớn');
	}
	try {
		return JSON.parse(raw) as T;
	} catch {
		throw AppError.badRequest('body không phải JSON hợp lệ');
	}
}

/** Idempotency-Key: cùng key + cùng endpoint => trả lại response đã lưu. */
export async function idempotencyHash(request: Request, body: unknown): Promise<string> {
	return sha256Hex(`${request.method}:${new URL(request.url).pathname}:${JSON.stringify(body ?? null)}`);
}

export function getIdempotencyKey(request: Request): string | null {
	const key = request.headers.get('idempotency-key');
	if (!key) return null;
	if (key.length > 200) throw AppError.badRequest('Idempotency-Key quá dài');
	return key;
}

export function clientIp(request: Request): string {
	const cfIp = request.headers.get('cf-connecting-ip');
	if (cfIp) return cfIp;
	return request.headers.get('x-forwarded-for')?.split(',')[0]?.trim() ?? 'unknown';
}

export function requestId(request: Request): string {
	return request.headers.get('cf-ray') ?? crypto.randomUUID();
}

export function getPathParam(context: Context, name: string): string {
	const value = context.req.param(name);
	if (!value) throw AppError.badRequest(`thiếu tham số ${name}`);
	return value;
}
