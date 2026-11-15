import { AppError } from '@alkcloud/core';

/**
 * Cursor keyset pagination — mã hoá cặp `(nameLower, id)` của dòng cuối đã trả.
 *
 * Vì sao không dùng `offset`: offset-based pagination "nhảy" dòng khi có file
 * mới được thêm/đổi tên giữa 2 lần gọi (thêm 1 file ở đầu danh sách ⇒ file cuối
 * của trang trước bị đẩy sang trang sau ⇒ hiển thị trùng). Keyset theo
 * `(name_lower, id)` ổn định: mọi lần gọi đều bắt đầu sau đúng mốc đã trả.
 */
export interface FileCursor {
	nameLower: string;
	id: string;
}

const toBase64Url = (bytes: Uint8Array): string => {
	let binary = '';
	for (const byte of bytes) binary += String.fromCharCode(byte);
	return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
};

const fromBase64Url = (value: string): Uint8Array => {
	const padded = value.replace(/-/g, '+').replace(/_/g, '/');
	const binary = atob(padded);
	const bytes = new Uint8Array(binary.length);
	for (let index = 0; index < binary.length; index += 1) {
		bytes[index] = binary.charCodeAt(index);
	}
	return bytes;
};

export function encodeFileCursor(cursor: FileCursor): string {
	return toBase64Url(new TextEncoder().encode(JSON.stringify([cursor.nameLower, cursor.id])));
}

export function decodeFileCursor(raw: string): FileCursor {
	try {
		const decoded = new TextDecoder().decode(fromBase64Url(raw));
		const parsed: unknown = JSON.parse(decoded);
		if (
			!Array.isArray(parsed) ||
			typeof parsed[0] !== 'string' ||
			typeof parsed[1] !== 'string' ||
			parsed[0].length === 0 ||
			parsed[1].length === 0
		) {
			throw new Error('cursor sai định dạng');
		}
		return { nameLower: parsed[0], id: parsed[1] };
	} catch {
		throw AppError.badRequest('Cursor không hợp lệ');
	}
}
