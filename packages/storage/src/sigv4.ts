/**
 * AWS Signature Version 4 (header auth + presigned query auth).
 * Tự implement để không phụ thuộc thư viện ngoài — Workers Free không cần bundle lớn.
 */

export interface SigV4Config {
	accessKeyId: string;
	secretAccessKey: string;
	region: string;
	service: string;
}

export interface SignRequestInput {
	method: string;
	endpoint: string;
	path: string;
	query?: Record<string, string>;
	headers?: Record<string, string>;
	payloadHash?: string;
	/** Body thực tế — dùng để tính `x-amz-content-sha256` khi không truyền `payloadHash`. */
	body?: string;
	expiresInSeconds?: number;
	now?: Date;
}

const UNSIGNED_PAYLOAD = 'UNSIGNED-PAYLOAD';

function toHex(buffer: ArrayBuffer): string {
	return Array.from(new Uint8Array(buffer))
		.map((byte) => byte.toString(16).padStart(2, '0'))
		.join('');
}

export async function sha256Hex(data: string | Uint8Array): Promise<string> {
	const bytes = typeof data === 'string' ? new TextEncoder().encode(data) : data;
	const digest = await crypto.subtle.digest('SHA-256', bytes as BufferSource);
	return toHex(digest);
}

async function hmac(key: Uint8Array, data: string): Promise<Uint8Array> {
	const cryptoKey = await crypto.subtle.importKey(
		'raw',
		key as BufferSource,
		{ name: 'HMAC', hash: 'SHA-256' },
		false,
		['sign'],
	);
	const signature = await crypto.subtle.sign('HMAC', cryptoKey, new TextEncoder().encode(data) as BufferSource);
	return new Uint8Array(signature);
}

export function encodeRfc3986(value: string): string {
	return encodeURIComponent(value).replace(
		/[!'()*]/g,
		(char) => `%${char.charCodeAt(0).toString(16).toUpperCase()}`,
	);
}

/**
 * Chuẩn hoá path cho canonical request.
 *
 * S3/B2 KHÔNG escape lại path đã serialize (AWS SDK dùng `uriEscapePath: false`
 * cho service `s3`). Vì vậy hàm này chỉ chuẩn hoá: bỏ escape kép đã có
 * (`%20` giữ nguyên `%20`, không thành `%2520`) và escape ký tự thô.
 *
 * `decodeURIComponent` có thể ném `URIError` với chuỗi `%` không hợp lệ —
 * trường hợp này giữ nguyên segment thay vì làm hỏng toàn bộ request.
 */
export function canonicalUri(path: string): string {
	const normalized = path.startsWith('/') ? path : `/${path}`;
	return normalized
		.split('/')
		.map((segment) => {
			let decoded = segment;
			try {
				decoded = decodeURIComponent(segment);
			} catch {
				return encodeRfc3986(segment);
			}
			return encodeRfc3986(decoded);
		})
		.join('/');
}

export function canonicalQueryString(query: Record<string, string> = {}): string {
	return Object.keys(query)
		.sort()
		.map((key) => `${encodeRfc3986(key)}=${encodeRfc3986(query[key] ?? '')}`)
		.join('&');
}

function amzDate(now: Date): { amzDate: string; dateStamp: string } {
	const amzDate = now.toISOString().replace(/[:-]|\.\d{3}/g, '');
	return { amzDate, dateStamp: amzDate.slice(0, 8) };
}

async function signingKey(config: SigV4Config, dateStamp: string): Promise<Uint8Array> {
	const kDate = await hmac(new TextEncoder().encode(`AWS4${config.secretAccessKey}`), dateStamp);
	const kRegion = await hmac(kDate, config.region);
	const kService = await hmac(kRegion, config.service);
	return hmac(kService, 'aws4_request');
}

function normalizeHeaders(headers: Record<string, string>): Record<string, string> {
	const normalized: Record<string, string> = {};
	for (const [key, value] of Object.entries(headers)) {
		normalized[key.toLowerCase().trim()] = value.trim().replace(/\s+/g, ' ');
	}
	return normalized;
}

function canonicalHeaders(headers: Record<string, string>): {
	canonical: string;
	signedHeaders: string;
} {
	const sorted = Object.keys(headers).sort();
	const canonical = `${sorted.map((key) => `${key}:${headers[key]}`).join('\n')}\n`;
	return { canonical, signedHeaders: sorted.join(';') };
}

/**
 * Ký header (Authorization) — dùng cho request nội bộ từ Worker tới B2.
 *
 * `x-amz-content-sha256` PHẢI là SHA-256 thật của body (hoặc hash của body rỗng
 * khi không có body) — KHÔNG dùng `UNSIGNED-PAYLOAD`. B2 kiểm tra hash này với
 * body thực tế; dùng `UNSIGNED-PAYLOAD` sẽ khiến POST/PUT có body bị
 * `SignatureDoesNotMatch` / `XAmzContentSHA256Mismatch`.
 */
export async function signRequest(
	config: SigV4Config,
	input: SignRequestInput,
): Promise<{ url: string; headers: Record<string, string> }> {
	const now = input.now ?? new Date();
	const { amzDate: stamp, dateStamp } = amzDate(now);
	const payloadHash =
		input.payloadHash ?? (input.body !== undefined ? await sha256Hex(input.body) : await sha256Hex(''));
	const url = new URL(input.endpoint);
	const headers = normalizeHeaders({
		host: url.host,
		'x-amz-content-sha256': payloadHash,
		'x-amz-date': stamp,
		...(input.headers ?? {}),
	});

	const canonicalRequest = [
		input.method.toUpperCase(),
		canonicalUri(input.path),
		canonicalQueryString(input.query),
		canonicalHeaders(headers).canonical,
		canonicalHeaders(headers).signedHeaders,
		payloadHash,
	].join('\n');

	const scope = `${dateStamp}/${config.region}/${config.service}/aws4_request`;
	const stringToSign = ['AWS4-HMAC-SHA256', stamp, scope, await sha256Hex(canonicalRequest)].join('\n');
	const key = await signingKey(config, dateStamp);
	const signature = toHex((await hmac(key, stringToSign)).buffer as ArrayBuffer);

	const authorization =
		`AWS4-HMAC-SHA256 Credential=${config.accessKeyId}/${scope}, ` +
		`SignedHeaders=${canonicalHeaders(headers).signedHeaders}, Signature=${signature}`;

	return {
		url: `${url.origin}${canonicalUri(input.path)}${input.query ? `?${canonicalQueryString(input.query)}` : ''}`,
		headers: {
			...headers,
			Authorization: authorization,
		},
	};
}

/**
 * Presigned URL (query auth).
 *
 * Theo chuẩn S3/B2, URL presign chỉ ký header `host` — client chỉ cần gửi
 * đúng các header đã ký. TTL tối đa 5 phút theo thiết kế AlkCloud.
 *
 * `X-Amz-Content-Sha256=UNSIGNED-PAYLOAD` phải nằm trong QUERY (không phải
 * header) — đúng như AWS S3RequestPresigner. Nếu để trong header, canonical
 * query string lệch với chuẩn ⇒ B2 trả SignatureDoesNotMatch.
 */
export async function presignUrl(
	config: SigV4Config,
	input: SignRequestInput,
): Promise<{ url: string; headers: Record<string, string>; expiresAt: string }> {
	const now = input.now ?? new Date();
	const { amzDate: stamp, dateStamp } = amzDate(now);
	const expiresIn = input.expiresInSeconds ?? 300;
	const payloadHash = input.payloadHash ?? UNSIGNED_PAYLOAD;
	const url = new URL(input.endpoint);
	// Chỉ ký `host`: các header `x-amz-*` đã được mang trong query.
	const signedHeaderNames = ['host'];
	const canonicalHeaderBlock = signedHeaderNames.map((key) => `${key}:${url.host}`).join('\n') + '\n';
	const signedHeaders = signedHeaderNames.join(';');

	const query: Record<string, string> = {
		...(input.query ?? {}),
		'X-Amz-Algorithm': 'AWS4-HMAC-SHA256',
		'X-Amz-Content-Sha256': payloadHash,
		'X-Amz-Credential': `${config.accessKeyId}/${dateStamp}/${config.region}/${config.service}/aws4_request`,
		'X-Amz-Date': stamp,
		'X-Amz-Expires': String(expiresIn),
		'X-Amz-SignedHeaders': signedHeaders,
	};

	const canonicalRequest = [
		input.method.toUpperCase(),
		canonicalUri(input.path),
		canonicalQueryString(query),
		canonicalHeaderBlock,
		signedHeaders,
		payloadHash,
	].join('\n');

	const scope = `${dateStamp}/${config.region}/${config.service}/aws4_request`;
	const stringToSign = ['AWS4-HMAC-SHA256', stamp, scope, await sha256Hex(canonicalRequest)].join('\n');
	const key = await signingKey(config, dateStamp);
	const signature = toHex((await hmac(key, stringToSign)).buffer as ArrayBuffer);

	return {
		url: `${url.origin}${canonicalUri(input.path)}?${canonicalQueryString(query)}&X-Amz-Signature=${signature}`,
		// Client chỉ gửi header nghiệp vụ (vd content-type). KHÔNG gửi lại
		// x-amz-content-sha256 / x-amz-date: chúng đã nằm trong query và
		// không nằm trong SignedHeaders => gửi thêm sẽ làm request lệch chuẩn.
		headers: { ...(input.headers ?? {}) },
		expiresAt: new Date(now.getTime() + expiresIn * 1000).toISOString(),
	};
}
