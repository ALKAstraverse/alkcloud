/** Định dạng dữ liệu hiển thị — dùng chung cho mọi màn hình. */

export function formatBytes(bytes: number): string {
	if (!Number.isFinite(bytes) || bytes < 0) return '—';
	if (bytes < 1024) return `${bytes} B`;
	const units = ['KB', 'MB', 'GB', 'TB', 'PB'];
	let value = bytes / 1024;
	let unit = 0;
	while (value >= 1024 && unit < units.length - 1) {
		value /= 1024;
		unit += 1;
	}
	return `${value >= 100 ? Math.round(value) : value.toFixed(1)} ${units[unit]}`;
}

const DATE_FORMAT = new Intl.DateTimeFormat('vi-VN', {
	day: '2-digit',
	month: '2-digit',
	year: 'numeric',
});

const TIME_FORMAT = new Intl.DateTimeFormat('vi-VN', {
	hour: '2-digit',
	minute: '2-digit',
});

export function formatDate(iso: string | null | undefined): string {
	if (!iso) return '—';
	const date = new Date(iso);
	if (Number.isNaN(date.getTime())) return '—';
	return DATE_FORMAT.format(date);
}

export function formatDateTime(iso: string | null | undefined): string {
	if (!iso) return '—';
	const date = new Date(iso);
	if (Number.isNaN(date.getTime())) return '—';
	return `${DATE_FORMAT.format(date)} · ${TIME_FORMAT.format(date)}`;
}

/** "3 phút trước", "2 giờ trước", "14/03/2026" — dùng cho metadata gần đây. */
export function formatRelative(iso: string | null | undefined, now = Date.now()): string {
	if (!iso) return '—';
	const time = new Date(iso).getTime();
	if (Number.isNaN(time)) return '—';
	const diff = now - time;
	if (diff < 0) return formatDate(iso);
	const minute = 60 * 1000;
	const hour = 60 * minute;
	const day = 24 * hour;
	if (diff < minute) return 'vừa xong';
	if (diff < hour) return `${Math.floor(diff / minute)} phút trước`;
	if (diff < day) return `${Math.floor(diff / hour)} giờ trước`;
	if (diff < 7 * day) return `${Math.floor(diff / day)} ngày trước`;
	return formatDate(iso);
}

/** Số ngày còn lại trước khi file trong thùng rác bị xoá vĩnh viễn. */
export function daysUntil(iso: string | null | undefined, now = Date.now()): number | null {
	if (!iso) return null;
	const time = new Date(iso).getTime();
	if (Number.isNaN(time)) return null;
	return Math.ceil((time - now) / (24 * 60 * 60 * 1000));
}

const DAY_MS = 24 * 60 * 60 * 1000;

export function formatRemaining(iso: string | null | undefined, now = Date.now()): string {
	const days = daysUntil(iso, now);
	if (days === null) return '—';
	if (days <= 0) return 'đến hạn xoá';
	if (days === 1) return 'còn 1 ngày';
	return `còn ${days} ngày`;
}

/** Mốc hết hạn giữ = thời điểm xoá + số ngày retention (thư mục không có cột purge_after). */
export function retentionDeadline(
	deletedAt: string | null | undefined,
	retentionDays: number,
): string | null {
	if (!deletedAt) return null;
	const time = Date.parse(deletedAt);
	if (Number.isNaN(time)) return null;
	return new Date(time + retentionDays * DAY_MS).toISOString();
}

const QUOTA_MODE_LABEL: Record<string, string> = {
	NORMAL: 'Bình thường',
	CONSERVE: 'Tiết kiệm',
	READ_ONLY: 'Chỉ đọc',
	EMERGENCY: 'Khẩn cấp',
};

/** Nhãn tiếng Việt cho chế độ quota của hệ thống. */
export function quotaModeLabel(mode: string): string {
	return QUOTA_MODE_LABEL[mode] ?? mode;
}
