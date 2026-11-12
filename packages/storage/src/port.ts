export interface PresignedTarget {
	url: string;
	method: 'PUT' | 'GET';
	headers: Record<string, string>;
	expiresAt: string;
}

export interface PresignPutRequest {
	key: string;
	contentType?: string;
	contentLength?: number;
	expiresInSeconds?: number;
}

export interface PresignPartRequest {
	key: string;
	uploadId: string;
	partNumber: number;
	expiresInSeconds?: number;
}

export interface MultipartPart {
	partNumber: number;
	etag: string;
	size: number;
}

export interface ObjectStat {
	key: string;
	size: number;
	contentType: string;
	etag: string | null;
	lastModified: string | null;
}

export interface ObjectVersion {
	versionId: string;
	isLatest: boolean;
	isDeleteMarker: boolean;
}

/**
 * Port lưu trữ object. Mặc định là B2 private bucket (S3-compatible).
 * Không public bucket: mọi đường đọc đều qua signed request hoặc presigned URL có TTL.
 */
export interface ObjectStorage {
	presignPut(request: PresignPutRequest): Promise<PresignedTarget>;
	presignUploadPart(request: PresignPartRequest): Promise<PresignedTarget>;
	presignGet(request: { key: string; expiresInSeconds?: number; responseContentType?: string }): Promise<PresignedTarget>;
	createMultipartUpload(request: { key: string; contentType: string }): Promise<{ uploadId: string }>;
	completeMultipartUpload(request: {
		key: string;
		uploadId: string;
		parts: MultipartPart[];
	}): Promise<{ etag: string | null; size: number | null }>;
	abortMultipartUpload(request: { key: string; uploadId: string }): Promise<void>;
	listParts(request: { key: string; uploadId: string }): Promise<MultipartPart[]>;
	headObject(key: string): Promise<ObjectStat | null>;
	/** Đọc object qua Worker (proxy) — hỗ trợ Range để download một phần. */
	getObject(key: string, range?: string): Promise<Response>;
	deleteObject(key: string): Promise<void>;
	listObjectVersions(key: string): Promise<ObjectVersion[]>;
	deleteObjectVersion(key: string, versionId: string): Promise<void>;
}

export class StorageError extends Error {
	constructor(
		message: string,
		readonly status?: number,
		readonly code?: string,
	) {
		super(message);
		this.name = 'StorageError';
	}
}
