import { AppError } from '@alkcloud/core';

/**
 * Kiểm tra header `Range` của request tải file.
 *
 * VÌ SAO cần (SEC-02): nếu chuyển thẳng `Range` của client xuống B2, một
 * Range không thỏa mãn (vd `bytes=999999999-`) khiến B2 trả **416**. Route share
 * đã `incrementShareDownload` TRƯỚC khi đọc object ⇒ lỗi 416 làm route hoàn lại
 * lượt tải ⇒ attacker dùng 416 để "reset" bộ đếm và tải vô hạn lần dù share có
 * `maxDownloads`.
 *
 * Cách sửa: validate Range dựa trên kích thước file ĐÃ BIẾT (D1) TRƯỚC khi
 * tăng bộ đếm. Range không thỏa mãn ⇒ 416 ngay, KHÔNG tiêu tốn lượt tải.
 *
 * Chỉ hỗ trợ dạng đơn giản `bytes=start-end` / `bytes=start-` / `bytes=-suffix`.
 * Dạng phức tạp (multi-range, nhiều khoảng) để B2 xử lý — nhưng khi đó KHÔNG
 * được tăng bộ đếm trước (xem `isRangeSatisfiable` trả `null` ⇒ caller bỏ qua
 * việc tiêu tốn lượt tải cho request có Range không kiểm chứng được).
 */
export interface RangeCheck {
	/** true = chắc chắn thỏa mãn; false = chắc chắn KHÔNG thỏa mãn; null = không xác định. */
	satisfiable: boolean | null;
	/** Header Range chuẩn hoá để gửi xuống B2 (null = không gửi). */
	normalized: string | null;
}

/**
 * @param range - header Range thô từ client
 * @param fileSize - kích thước file theo metadata D1 (đã xác minh lúc complete)
 */
export function checkRange(range: string | null | undefined, fileSize: number): RangeCheck {
	if (!range) return { satisfiable: true, normalized: null };
	const trimmed = range.trim();
	const match = /^bytes=(\d*)-(\d*)$/.exec(trimmed);
	if (!match) {
		// Dạng không kiểm chứng được (multi-range, unit khác) ⇒ không tiêu tốn lượt.
		return { satisfiable: null, normalized: trimmed };
	}
	const startRaw = match[1] ?? '';
	const endRaw = match[2] ?? '';
	if (startRaw === '' && endRaw === '') return { satisfiable: false, normalized: null };

	if (startRaw === '') {
		// Suffix range: bytes=-N ⇒ lấy N byte cuối.
		const suffix = Number(endRaw);
		if (!Number.isFinite(suffix) || suffix <= 0) return { satisfiable: false, normalized: null };
		if (fileSize === 0) return { satisfiable: false, normalized: null };
		return { satisfiable: true, normalized: trimmed };
	}

	const start = Number(startRaw);
	if (!Number.isFinite(start) || start < 0) return { satisfiable: false, normalized: null };
	if (start >= fileSize) return { satisfiable: false, normalized: null };
	if (endRaw !== '') {
		const end = Number(endRaw);
		if (!Number.isFinite(end) || end < start) return { satisfiable: false, normalized: null };
	}
	return { satisfiable: true, normalized: trimmed };
}

/** Ném 416 nếu Range chắc chắn không thỏa mãn. */
export function assertRangeSatisfiable(range: string | null | undefined, fileSize: number): string | null {
	const check = checkRange(range, fileSize);
	if (check.satisfiable === false) {
		throw new AppError('range_not_satisfiable', 'Range không thỏa mãn');
	}
	return check.normalized;
}
