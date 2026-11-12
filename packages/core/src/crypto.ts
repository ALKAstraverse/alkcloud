const encoder = new TextEncoder();

export function toHex(buffer: ArrayBuffer): string {
	return Array.from(new Uint8Array(buffer))
		.map((b) => b.toString(16).padStart(2, '0'))
		.join('');
}

export async function sha256Hex(input: string | Uint8Array): Promise<string> {
	const data = typeof input === 'string' ? encoder.encode(input) : input;
	const digest = await crypto.subtle.digest('SHA-256', data as BufferSource);
	return toHex(digest);
}

export function randomBytes(length: number): Uint8Array {
	const bytes = new Uint8Array(length);
	crypto.getRandomValues(bytes);
	return bytes;
}

export async function hmacHex(secret: string, data: string): Promise<string> {
	const key = await crypto.subtle.importKey(
		'raw',
		encoder.encode(secret) as BufferSource,
		{ name: 'HMAC', hash: 'SHA-256' },
		false,
		['sign'],
	);
	const signature = await crypto.subtle.sign('HMAC', key, encoder.encode(data) as BufferSource);
	return toHex(signature);
}

export function base64UrlEncode(bytes: Uint8Array): string {
	let binary = '';
	for (const byte of bytes) binary += String.fromCharCode(byte);
	return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

export function base64UrlDecode(value: string): Uint8Array {
	const padded = value.replace(/-/g, '+').replace(/_/g, '/');
	const binary = atob(padded + '='.repeat((4 - (padded.length % 4)) % 4));
	const bytes = new Uint8Array(binary.length);
	for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
	return bytes;
}

/** Token ngẫu nhiên dùng cho share/session; chỉ lưu hash trong DB. */
export function randomToken(byteLength = 32): string {
	return base64UrlEncode(randomBytes(byteLength));
}

/** ID sortable theo thời gian + ngẫu nhiên, không chứa PII. */
export function newId(prefix: string): string {
	const now = Date.now().toString(36).padStart(9, '0');
	const rand = base64UrlEncode(randomBytes(9)).slice(0, 10);
	return `${prefix}_${now}${rand}`;
}

/**
 * So sánh thời gian hằng số cho chuỗi cùng độ dài.
 *
 * Lưu ý: vẫn chạy vòng lặp dù độ dài khác nhau (so sánh với chuỗi rỗng) để
 * không rò rỉ độ dài qua thời gian thực thi. Chuỗi dài hơn bị cắt bỏ phần thừa
 * ⇒ vẫn trả false chính xác khi một chuỗi là tiền tố của chuỗi kia.
 */
export function timingSafeEqual(a: string, b: string): boolean {
	const length = Math.max(a.length, b.length);
	let diff = a.length ^ b.length;
	for (let i = 0; i < length; i++) {
		const charA = i < a.length ? a.charCodeAt(i) : 0;
		const charB = i < b.length ? b.charCodeAt(i) : 0;
		diff |= charA ^ charB;
	}
	return diff === 0;
}
