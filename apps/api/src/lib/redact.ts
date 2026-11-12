/**
 * Redaction cho log Workers.
 *
 * Mục tiêu: KHÔNG BAO GIỜ ghi secret/credential vào Workers Logs (retention 3 ngày,
 * đọc được bởi mọi người có quyền xem log của account).
 *
 * Nguồn rủi ro thực tế:
 * - `console.error('unhandled error', error)` — error object có thể chứa message
 *   của thư viện B2/S3 với URL đã ký (`X-Amz-Signature=...`) hoặc header auth.
 * - Fallback audit ghi JSON — `metadata`/message có thể vô tình chứa token.
 *
 * Cách xử lý: thay mọi cặp `khoá=giá trị` của khoá nhạy cảm bằng `khoá=[REDACTED]`,
 * đồng thời che chữ ký S3 và Bearer token nếu lọt vào text tự do.
 */

/** Tên khoá hay bị lộ khi log (so khớp không phân biệt hoa thường). */
const SENSITIVE_KEYS = [
	'secretaccesskey',
	'applicationkey',
	'accesskeyid',
	'keyid',
	'authkey',
	'authpepper',
	'password',
	'passwd',
	'pwd',
	'passwordverifier',
	'passwordhash',
	'token',
	'grant',
	'setuptoken',
	'bootstraptoken',
	'csrftoken',
	'csrfsecret',
	'cookie',
	'set-cookie',
	'authorization',
	'x-share-token',
	'x-share-grant',
	'x-alkcloud-csrf',
	'x-amz-signature',
	'x-amz-credential',
	'x-amz-security-token',
	'signature',
	'sessiontoken',
	'refreshtoken',
	'privatekey',
	'clientsecret',
	'client_secret',
	'dbpassword',
	'database_url',
];

const REDACTED = '[REDACTED]';

/**
 * Che giá trị của các khoá nhạy cảm trong chuỗi `khoá=giá trị` / `khoá: giá trị`.
 * Không thay thế toàn bộ giá trị (giữ nguyên tên khoá) để log vẫn hữu ích.
 */
export function redactSecrets(input: string): string {
	if (!input) return input;
	let out = input;

	// 1. Dạng JSON: `"khoá": "giá trị"` — che trọn vẹn giá trị trong dấu nháy.
	const jsonKey = SENSITIVE_KEYS.map(escapeRegExp).join('|');
	out = out.replace(
		new RegExp(`("(?:${jsonKey})"\\s*:\\s*)"(?:[^"\\\\]|\\\\.)*"`, 'gi'),
		`$1"${REDACTED}"`,
	);

	// 2. Header Authorization: che cả phần `Bearer <token>`.
	out = out.replace(
		/((?:proxy-)?authorization\s*[=:]\s*)(?:bearer\s+)?[^\s&"',;)}\]]+/gi,
		`$1${REDACTED}`,
	);

	// 3. `khoá=giá trị` / `khoá: giá trị` — khoá nằm trong danh sách nhạy cảm.
	for (const key of SENSITIVE_KEYS) {
		// Giá trị kết thúc ở dấu phân tách tiếp theo (&, ", ', whitespace, , hoặc cuối chuỗi).
		const pattern = new RegExp(
			`(${escapeRegExp(key)})(\\s*[=:]\\s*)([^&\\s"',;)}\\]]+)`,
			'gi',
		);
		out = out.replace(pattern, `$1$2${REDACTED}`);
	}

	// 4. Bearer token trong text tự do.
	out = out.replace(/(Bearer\s+)[A-Za-z0-9._~+/=-]{8,}/gi, `$1${REDACTED}`);

	// 5. Chuỗi trông như secret dài gắn liền trong text tự do (hex/base64 >= 40 ký tự)
	//    chỉ khi đứng sau dấu `=` — tránh che nhầm hash/ETag hợp lệ trong log.
	out = out.replace(/([=:]\s*)([A-Za-z0-9+/=_-]{40,})/g, `$1${REDACTED}`);

	return out;
}

function escapeRegExp(value: string): string {
	return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/**
 * Bọc giá trị trong object để log an toàn.
 * - `undefined`/`null` giữ nguyên.
 * - `Error` ⇒ chỉ giữ `name` + `message` (đã redact) + `status`/`code` nếu có.
 * - Object thường ⇒ redact đệ quy các giá trị chuỗi và bỏ các khoá nhạy cảm.
 */
export function redactValue<T>(value: T, depth = 0): unknown {
	if (value === null || value === undefined) return value;
	if (depth > 4) return '[TRUNCATED]';
	if (typeof value === 'string') return redactSecrets(value);
	if (typeof value !== 'object') return value;

	if (value instanceof Error) {
		const error = value as Error & { status?: number; code?: string };
		return {
			name: error.name,
			message: redactSecrets(error.message),
			...(error.status !== undefined ? { status: error.status } : {}),
			...(error.code !== undefined ? { code: error.code } : {}),
		};
	}
	if (Array.isArray(value)) {
		return value.slice(0, 50).map((item) => redactValue(item, depth + 1));
	}

	const out: Record<string, unknown> = {};
	for (const [key, item] of Object.entries(value as Record<string, unknown>)) {
		if (SENSITIVE_KEYS.includes(key.toLowerCase())) {
			out[key] = REDACTED;
			continue;
		}
		out[key] = redactValue(item, depth + 1);
	}
	return out;
}
