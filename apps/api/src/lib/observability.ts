import { redactValue } from './redact.js';

/**
 * WS-K — Log có cấu trúc cho Workers Logs.
 *
 * Workers Free KHÔNG có Analytics Engine, không có metrics API mà không cần token,
 * và log chỉ giữ **3 ngày**. Vì vậy "observability" ở đây = log JSON có cấu trúc
 * + số liệu sức khoẻ lưu trong D1 (xem `system_health`).
 *
 * Quy tắc bất di bất dịch:
 *   1. Mỗi dòng log là **một JSON object** (1 dòng) ⇒ `jq` / grep được.
 *   2. Mọi giá trị đi qua `redactValue` ⇒ không rò secret vào log.
 *   3. Không bao giờ log dữ liệu người dùng (tên file, email, nội dung).
 *   4. `level` + `event` là bắt buộc ⇒ lọc/siêu tảo được.
 *
 * `console.log` chỉ được dùng ở ĐÚNG file này (kiểm tra bởi
 * `infra/check-log-safety.sh`).
 */

export type LogLevel = 'info' | 'warn' | 'error';

/**
 * Catalog sự kiện — đặt tên ổn định để log có thể truy vấn theo thời gian.
 * Thêm event mới ⇒ thêm vào đây (không tự invent tên ở nơi gọi).
 */
export const EVENTS = {
	requestFailed: 'request.failed',
	requestRateLimited: 'request.rate_limited',
	storageCircuitOpen: 'storage.circuit_open',
	storageRetry: 'storage.retry',
	storageError: 'storage.error',
	auditFallback: 'audit.fallback',
	cronStarted: 'cron.started',
	cronCompleted: 'cron.completed',
	cronFailed: 'cron.failed',
	quotaModeChanged: 'quota.mode_changed',
	quotaStateEvaluated: 'quota.state_evaluated',
	degradationBlocked: 'degradation.blocked',
	uploadSessionExpired: 'upload.session_expired',
	filePurged: 'file.purged',
} as const;

export type EventName = (typeof EVENTS)[keyof typeof EVENTS];

export interface LogFields {
	/** Đường dẫn route (KHÔNG kèm query string — có thể chứa token). */
	path?: string;
	method?: string;
	status?: number;
	durationMs?: number;
	errorCode?: string;
	errorName?: string;
	[key: string]: unknown;
}

let sequence = 0;

/**
 * Ghi 1 sự kiện. `fields` phải là dữ liệu đã ẩn danh.
 */
export function emit(level: LogLevel, event: EventName, fields: LogFields = {}): void {
	sequence = (sequence + 1) % 1_000_000;
	const payload = {
		ts: new Date().toISOString(),
		level,
		event,
		seq: sequence,
		...(redactValue(fields) as Record<string, unknown>),
	};
	// 1 dòng JSON — không dùng console.error vì đây không phải lỗi.
	console.log(JSON.stringify(payload));
}

export function info(event: EventName, fields: LogFields = {}): void {
	emit('info', event, fields);
}

export function warn(event: EventName, fields: LogFields = {}): void {
	emit('warn', event, fields);
}

export function error(event: EventName, fields: LogFields = {}): void {
	emit('error', event, fields);
}
