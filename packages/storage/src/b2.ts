import type {
	ListObjectsResult,
	MultipartPart,
	ObjectListEntry,
	ObjectStat,
	ObjectStorage,
	ObjectVersion,
	PresignPartRequest,
	PresignPutRequest,
	PresignedTarget,
} from './port.js';
import { StorageError } from './port.js';
import { presignUrl, signRequest, type SigV4Config } from './sigv4.js';

export interface B2StorageConfig {
	endpoint: string;
	region: string;
	bucket: string;
	accessKeyId: string;
	secretAccessKey: string;
	/** TTL mặc định cho presigned URL (thiết kế AlkCloud: 5 phút). */
	defaultExpirySeconds?: number;
}

interface XmlTag {
	name: string;
	value: string;
}

/** Trích giá trị text của các tag đơn giản từ XML S3 (không dùng DOMParser trong Worker). */
export function extractXmlValues(xml: string, tagNames: string[]): XmlTag[] {
	const results: XmlTag[] = [];
	for (const tagName of tagNames) {
		const regex = new RegExp(`<${tagName}>([\\s\\S]*?)</${tagName}>`, 'g');
		let match: RegExpExecArray | null;
		while ((match = regex.exec(xml)) !== null) {
			results.push({ name: tagName, value: decodeXmlEntities(match[1] ?? '') });
		}
	}
	return results;
}

const XML_ENTITIES: Record<string, string> = {
	lt: '<',
	gt: '>',
	quot: '"',
	apos: "'",
	amp: '&',
};

/**
 * Decode XML entity trong text node.
 * Dùng single-pass regex (thay vì chuỗi `.replace` nối tiếp) để entity `&lt;`
 * giải mã đúng một lần thành `&` chứ không thành ký tự `<`.
 */
function decodeXmlEntities(value: string): string {
	return value.replace(/&([a-z]+);/g, (match, name: string) => XML_ENTITIES[name] ?? match);
}

export class B2Storage implements ObjectStorage {
	private readonly config: SigV4Config & { endpoint: string; bucket: string };
	private readonly defaultExpiry: number;

	constructor(config: B2StorageConfig) {
		this.config = {
			endpoint: config.endpoint.replace(/\/+$/, ''),
			region: config.region,
			bucket: config.bucket,
			accessKeyId: config.accessKeyId,
			secretAccessKey: config.secretAccessKey,
			service: 's3',
		};
		this.defaultExpiry = config.defaultExpirySeconds ?? 300;
	}

	private objectPath(key: string): string {
		const encodedKey = key
			.split('/')
			.map((segment) => encodeURIComponent(segment))
			.join('/');
		const bucket = encodeURIComponent(this.config.bucket);
		// Key rỗng (vd listObjectVersions) ⇒ `/<bucket>` không có slash cuối,
		// khớp canonical URI chuẩn S3 (tránh `/bucket/` gây lệch signature ở một số endpoint).
		return encodedKey ? `/${bucket}/${encodedKey}` : `/${bucket}`;
	}

	private async presign(
		method: 'PUT' | 'GET',
		key: string,
		query: Record<string, string>,
		headers: Record<string, string>,
		expiresInSeconds?: number,
	): Promise<PresignedTarget> {
		const result = await presignUrl(this.config, {
			method,
			endpoint: this.config.endpoint,
			path: this.objectPath(key),
			query,
			headers,
			expiresInSeconds: expiresInSeconds ?? this.defaultExpiry,
		});
		return { url: result.url, method, headers: result.headers, expiresAt: result.expiresAt };
	}

	async presignPut(request: PresignPutRequest): Promise<PresignedTarget> {
		// `content-type` là header KHÔNG được ký (S3 presign chỉ ký `host`) —
		// client gửi kèm header này khi PUT, B2 dùng để lưu metadata object.
		const headers: Record<string, string> = {};
		if (request.contentType) headers['content-type'] = request.contentType;
		return this.presign('PUT', request.key, {}, headers, request.expiresInSeconds);
	}

	async presignUploadPart(request: PresignPartRequest): Promise<PresignedTarget> {
		return this.presign(
			'PUT',
			request.key,
			{ partNumber: String(request.partNumber), uploadId: request.uploadId },
			{},
			request.expiresInSeconds,
		);
	}

	async presignGet(request: {
		key: string;
		expiresInSeconds?: number;
		responseContentType?: string;
	}): Promise<PresignedTarget> {
		// `response-content-type` là QUERY parameter của S3 GetObject (không phải header).
		const query: Record<string, string> = {};
		if (request.responseContentType) query['response-content-type'] = request.responseContentType;
		return this.presign('GET', request.key, query, {}, request.expiresInSeconds);
	}

	private async signedFetch(
		method: string,
		key: string,
		options: { query?: Record<string, string>; headers?: Record<string, string>; body?: string } = {},
	): Promise<Response> {
		const path = this.objectPath(key);
		const signed = await signRequest(this.config, {
			method,
			endpoint: this.config.endpoint,
			path,
			query: options.query,
			headers: options.headers,
			body: options.body,
		});
		// `signed.url` đã chứa canonical query string do signRequest dựng — không nối thêm lần nữa.
		return fetch(signed.url, {
			method,
			headers: signed.headers,
			body: options.body,
		});
	}

	async createMultipartUpload(request: { key: string; contentType: string }): Promise<{ uploadId: string }> {
		const response = await this.signedFetch('POST', request.key, {
			query: { uploads: '' },
			headers: { 'content-type': request.contentType },
		});
		if (!response.ok) {
			throw new StorageError(`createMultipartUpload failed: ${response.status}`, response.status);
		}
		const xml = await response.text();
		const uploadId = extractXmlValues(xml, ['UploadId'])[0]?.value;
		if (!uploadId) throw new StorageError('createMultipartUpload: thiếu UploadId trong response');
		return { uploadId };
	}

	async completeMultipartUpload(request: {
		key: string;
		uploadId: string;
		parts: MultipartPart[];
	}): Promise<{ etag: string | null; size: number | null }> {
		const body = `<CompleteMultipartUpload>${request.parts
			.map(
				(part) =>
					`<Part><PartNumber>${part.partNumber}</PartNumber><ETag>"${part.etag.replace(/"/g, '')}"</ETag></Part>`,
			)
			.join('')}</CompleteMultipartUpload>`;
		const response = await this.signedFetch('POST', request.key, {
			query: { uploadId: request.uploadId },
			headers: { 'content-type': 'application/xml' },
			body,
		});
		if (!response.ok) {
			throw new StorageError(`completeMultipartUpload failed: ${response.status}`, response.status);
		}
		const xml = await response.text();
		const etag = extractXmlValues(xml, ['ETag'])[0]?.value ?? null;
		const sizeRaw = extractXmlValues(xml, ['Size'])[0]?.value;
		return { etag, size: sizeRaw ? Number(sizeRaw) : null };
	}

	async abortMultipartUpload(request: { key: string; uploadId: string }): Promise<void> {
		const response = await this.signedFetch('DELETE', request.key, { query: { uploadId: request.uploadId } });
		if (!response.ok && response.status !== 404) {
			throw new StorageError(`abortMultipartUpload failed: ${response.status}`, response.status);
		}
	}

	async listParts(request: { key: string; uploadId: string }): Promise<MultipartPart[]> {
		const response = await this.signedFetch('GET', request.key, { query: { uploadId: request.uploadId } });
		if (!response.ok) {
			throw new StorageError(`listParts failed: ${response.status}`, response.status);
		}
		const xml = await response.text();
		const parts: MultipartPart[] = [];
		const partRegex = /<Part>([\s\S]*?)<\/Part>/g;
		let match: RegExpExecArray | null;
		while ((match = partRegex.exec(xml)) !== null) {
			const chunk = match[1] ?? '';
			const partNumber = Number(extractXmlValues(chunk, ['PartNumber'])[0]?.value ?? '0');
			const etag = extractXmlValues(chunk, ['ETag'])[0]?.value ?? '';
			const size = Number(extractXmlValues(chunk, ['Size'])[0]?.value ?? '0');
			if (partNumber > 0) parts.push({ partNumber, etag, size });
		}
		return parts.sort((a, b) => a.partNumber - b.partNumber);
	}

	async headObject(key: string): Promise<ObjectStat | null> {
		const response = await this.signedFetch('HEAD', key);
		if (response.status === 404) return null;
		if (!response.ok) throw new StorageError(`headObject failed: ${response.status}`, response.status);
		const length = response.headers.get('content-length');
		return {
			key,
			size: length ? Number(length) : 0,
			contentType: response.headers.get('content-type') ?? 'application/octet-stream',
			etag: response.headers.get('etag'),
			lastModified: response.headers.get('last-modified'),
		};
	}

	async getObject(key: string, range?: string): Promise<Response> {
		const headers: Record<string, string> = {};
		if (range) headers.range = range;
		const response = await this.signedFetch('GET', key, { headers });
		if (!response.ok && response.status !== 206) {
			throw new StorageError(`getObject failed: ${response.status}`, response.status);
		}
		return response;
	}

	async deleteObject(key: string): Promise<void> {
		const response = await this.signedFetch('DELETE', key);
		if (!response.ok && response.status !== 404) {
			throw new StorageError(`deleteObject failed: ${response.status}`, response.status);
		}
	}

	async listObjectVersions(key: string): Promise<ObjectVersion[]> {
		const response = await this.signedFetch('GET', '', {
			query: { versions: '', prefix: key },
		});
		if (!response.ok) {
			throw new StorageError(`listObjectVersions failed: ${response.status}`, response.status);
		}
		const xml = await response.text();
		const versions: ObjectVersion[] = [];
		const versionRegex = /<Version>([\s\S]*?)<\/Version>/g;
		let match: RegExpExecArray | null;
		while ((match = versionRegex.exec(xml)) !== null) {
			const chunk = match[1] ?? '';
			const versionId = extractXmlValues(chunk, ['VersionId'])[0]?.value;
			if (!versionId) continue;
			versions.push({
				versionId,
				isLatest: /<IsLatest>true<\/IsLatest>/.test(chunk),
				isDeleteMarker: false,
			});
		}
		const markerRegex = /<DeleteMarker>([\s\S]*?)<\/DeleteMarker>/g;
		while ((match = markerRegex.exec(xml)) !== null) {
			const chunk = match[1] ?? '';
			const versionId = extractXmlValues(chunk, ['VersionId'])[0]?.value;
			if (versionId) {
				versions.push({ versionId, isLatest: false, isDeleteMarker: true });
			}
		}
		return versions;
	}

	async deleteObjectVersion(key: string, versionId: string): Promise<void> {
		const response = await this.signedFetch('DELETE', key, { query: { versionId } });
		if (!response.ok && response.status !== 404) {
			throw new StorageError(`deleteObjectVersion failed: ${response.status}`, response.status);
		}
	}

	/**
	 * S3 ListObjectsV2 — liệt kê object trong bucket để audit/reconcile.
	 *
	 * Vì sao cần: phát hiện "object mồ côi" (B2 còn object nhưng D1 đã mất metadata)
	 * là điều mà `headObject` từng-ke không thể thấy — phải duyệt toàn bucket.
	 *
	 * B2 trả XML với namespace mặc định; `extractXmlValues` bỏ qua namespace nên
	 * hoạt động với cả dạng `<Contents>` lẫn `<ns:Contents>`.
	 */
	async listObjects(request: {
		prefix?: string;
		continuationToken?: string;
		maxKeys?: number;
	} = {}): Promise<ListObjectsResult> {
		const query: Record<string, string> = { 'list-type': '2' };
		if (request.prefix) query.prefix = request.prefix;
		if (request.continuationToken) query['continuation-token'] = request.continuationToken;
		if (request.maxKeys) query['max-keys'] = String(request.maxKeys);

		const response = await this.signedFetch('GET', '', { query });
		if (!response.ok) {
			throw new StorageError(`listObjects failed: ${response.status}`, response.status);
		}
		const xml = await response.text();
		const objects: ObjectListEntry[] = [];

		// Mỗi object nằm trong thẻ `<Contents>…</Contents>`.
		const contentsRegex = /<(?:\w+:)?Contents>([\s\S]*?)<\/(?:\w+:)?Contents>/g;
		let match: RegExpExecArray | null;
		while ((match = contentsRegex.exec(xml)) !== null) {
			const chunk = match[1] ?? '';
			const key = decodeXmlEntities(extractXmlValues(chunk, ['Key'])[0]?.value ?? '');
			if (!key) continue;
			const sizeRaw = extractXmlValues(chunk, ['Size'])[0]?.value;
			const lastModified = extractXmlValues(chunk, ['LastModified'])[0]?.value;
			objects.push({
				key,
				size: sizeRaw ? Number(sizeRaw) : 0,
				etag: extractXmlValues(chunk, ['ETag'])[0]?.value ?? null,
				lastModified: lastModified ?? null,
			});
		}

		const truncated = /<(?:\w+:)?IsTruncated>true<\/(?:\w+:)?IsTruncated>/.test(xml);
		const nextToken = truncated
			? (extractXmlValues(xml, ['NextContinuationToken'])[0]?.value ?? null)
			: null;
		return { objects, nextContinuationToken: nextToken };
	}
}
