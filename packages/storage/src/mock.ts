import type {
	ListObjectsResult,
	MultipartPart,
	ObjectStat,
	ObjectStorage,
	ObjectVersion,
	PresignPartRequest,
	PresignPutRequest,
	PresignedTarget,
} from './port.js';

interface MockObject {
	size: number;
	contentType: string;
	etag: string;
	body: Uint8Array;
	updatedAt: string;
}

interface MockMultipart {
	uploadId: string;
	key: string;
	parts: Map<number, { etag: string; size: number }>;
}

/**
 * Adapter giả lập cho test/local khi chưa có B2 thật.
 * Không tự tạo credential giả và không báo "kết nối thành công" — nó chỉ mô phỏng hành vi.
 */
export class MockObjectStorage implements ObjectStorage {
	readonly objects = new Map<string, MockObject>();
	readonly multiparts = new Map<string, MockMultipart>();
	readonly calls: string[] = [];

	private counter = 0;
	/** Lỗi ép mọi thao tác thất bại (dùng để test hành vi khi hạ tầng lỗi). */
	private forcedError: Error | null = null;

	/** Ép mọi thao tác storage ném lỗi này (mô phỏng B2 hỏng / circuit mở). */
	failWith(error: Error): void {
		this.forcedError = error;
	}

	/** Bỏ ép lỗi. */
	clearFailure(): void {
		this.forcedError = null;
	}

	private failIfForced(): void {
		if (this.forcedError) throw this.forcedError;
	}

	async presignPut(request: PresignPutRequest): Promise<PresignedTarget> {
		this.calls.push('presignPut');
		this.failIfForced();
		const expiresIn = request.expiresInSeconds ?? 300;
		return {
			url: `https://mock.invalid/put/${encodeURIComponent(request.key)}`,
			method: 'PUT',
			headers: request.contentType ? { 'content-type': request.contentType } : {},
			expiresAt: new Date(Date.now() + expiresIn * 1000).toISOString(),
		};
	}

	async presignUploadPart(request: PresignPartRequest): Promise<PresignedTarget> {
		this.calls.push('presignUploadPart');
		this.failIfForced();
		const expiresIn = request.expiresInSeconds ?? 300;
		return {
			url: `https://mock.invalid/part/${encodeURIComponent(request.key)}/${request.partNumber}`,
			method: 'PUT',
			headers: {},
			expiresAt: new Date(Date.now() + expiresIn * 1000).toISOString(),
		};
	}

	async presignGet(request: { key: string; expiresInSeconds?: number }): Promise<PresignedTarget> {
		this.calls.push('presignGet');
		this.failIfForced();
		const expiresIn = request.expiresInSeconds ?? 300;
		return {
			url: `https://mock.invalid/get/${encodeURIComponent(request.key)}`,
			method: 'GET',
			headers: {},
			expiresAt: new Date(Date.now() + expiresIn * 1000).toISOString(),
		};
	}

	async createMultipartUpload(request: { key: string; contentType: string }): Promise<{ uploadId: string }> {
		this.calls.push('createMultipartUpload');
		this.failIfForced();
		this.counter += 1;
		const uploadId = `mock-upload-${this.counter}`;
		this.multiparts.set(uploadId, { uploadId, key: request.key, parts: new Map() });
		return { uploadId };
	}

	/** Dùng trong test để giả lập client đã PUT part lên B2. */
	putPart(uploadId: string, partNumber: number, size: number): { etag: string } {
		const multipart = this.multiparts.get(uploadId);
		if (!multipart) throw new Error(`unknown uploadId ${uploadId}`);
		const etag = `mock-etag-${uploadId}-${partNumber}`;
		multipart.parts.set(partNumber, { etag, size });
		return { etag };
	}

	/** Dùng trong test để giả lập client đã PUT một object hoàn chỉnh lên B2. */
	putObject(
		key: string,
		data: { size: number; contentType?: string; etag?: string; body?: Uint8Array },
	): { etag: string } {
		const etag = data.etag ?? `mock-etag-${key}`;
		this.objects.set(key, {
			size: data.size,
			contentType: data.contentType ?? 'application/octet-stream',
			etag,
			body: data.body ?? new Uint8Array(0),
			updatedAt: new Date().toISOString(),
		});
		return { etag };
	}

	/** Trả về key gốc từ URL presign của mock (hỗ trợ test single-part). */
	keyFromPresignedUrl(url: string): string {
		const marker = url.includes('/put/') ? '/put/' : '/part/';
		const index = url.indexOf(marker);
		if (index < 0) throw new Error(`không phải URL presign của mock: ${url}`);
		return decodeURIComponent(url.slice(index + marker.length));
	}

	async completeMultipartUpload(request: {
		key: string;
		uploadId: string;
		parts: MultipartPart[];
	}): Promise<{ etag: string | null; size: number | null }> {
		this.calls.push('completeMultipartUpload');
		this.failIfForced();
		const multipart = this.multiparts.get(request.uploadId);
		if (!multipart) throw new Error(`unknown uploadId ${request.uploadId}`);
		const missing = request.parts.filter((part) => !multipart.parts.has(part.partNumber));
		if (missing.length > 0) {
			throw new Error(`thiếu part: ${missing.map((part) => part.partNumber).join(',')}`);
		}
		const totalSize = request.parts.reduce((sum, part) => sum + (multipart.parts.get(part.partNumber)?.size ?? 0), 0);
		const etag = `mock-etag-${request.uploadId}`;
		this.objects.set(request.key, {
			size: totalSize,
			contentType: 'application/octet-stream',
			etag,
			body: new Uint8Array(0),
			updatedAt: new Date().toISOString(),
		});
		this.multiparts.delete(request.uploadId);
		return { etag, size: totalSize };
	}

	async abortMultipartUpload(request: { key: string; uploadId: string }): Promise<void> {
		this.calls.push('abortMultipartUpload');
		this.failIfForced();
		this.multiparts.delete(request.uploadId);
	}

	async listParts(request: { key: string; uploadId: string }): Promise<MultipartPart[]> {
		this.calls.push('listParts');
		this.failIfForced();
		const multipart = this.multiparts.get(request.uploadId);
		if (!multipart) return [];
		return [...multipart.parts.entries()]
			.map(([partNumber, part]) => ({ partNumber, etag: part.etag, size: part.size }))
			.sort((a, b) => a.partNumber - b.partNumber);
	}

	async headObject(key: string): Promise<ObjectStat | null> {
		this.calls.push('headObject');
		this.failIfForced();
		const object = this.objects.get(key);
		if (!object) return null;
		return {
			key,
			size: object.size,
			contentType: object.contentType,
			etag: object.etag,
			lastModified: object.updatedAt,
		};
	}

	async getObject(key: string, range?: string): Promise<Response> {
		this.calls.push('getObject');
		this.failIfForced();
		const object = this.objects.get(key);
		if (!object) return new Response('not found', { status: 404 });

		// Mô phỏng đúng hành vi S3 cho `Range: bytes=start-end` (206 + Content-Range).
		if (range) {
			const match = /^bytes=(\d*)-(\d*)$/.exec(range.trim());
			if (match) {
				const body = object.body;
				const total = object.size || body.length;
				let start = match[1] ? Number(match[1]) : 0;
				let end = match[2] ? Number(match[2]) : total - 1;
				if (!match[1] && match[2]) {
					start = Math.max(0, total - Number(match[2]));
					end = total - 1;
				}
				if (start >= total || start > end) {
					return new Response(null, {
						status: 416,
						headers: { 'content-range': `bytes */${total}` },
					});
				}
				end = Math.min(end, total - 1);
				const slice = body.subarray(start, end + 1);
				return new Response(slice as BodyInit, {
					status: 206,
					headers: {
						'content-type': object.contentType,
						'content-length': String(slice.length),
						'content-range': `bytes ${start}-${end}/${total}`,
						'accept-ranges': 'bytes',
						etag: object.etag,
					},
				});
			}
		}

		return new Response(object.body as BodyInit, {
			status: 200,
			headers: {
				'content-type': object.contentType,
				'content-length': String(object.size),
				etag: object.etag,
				'accept-ranges': 'bytes',
			},
		});
	}

	async deleteObject(key: string): Promise<void> {
		this.calls.push('deleteObject');
		this.failIfForced();
		this.objects.delete(key);
	}

	async listObjectVersions(key: string): Promise<ObjectVersion[]> {
		this.calls.push('listObjectVersions');
		this.failIfForced();
		const object = this.objects.get(key);
		if (!object) return [];
		return [{ versionId: 'mock-version-1', isLatest: true, isDeleteMarker: false }];
	}

	async deleteObjectVersion(key: string, versionId: string): Promise<void> {
		this.calls.push('deleteObjectVersion');
		this.failIfForced();
		if (this.objects.has(key)) this.objects.delete(key);
	}

	async listObjects(request: {
		prefix?: string;
		continuationToken?: string;
		maxKeys?: number;
	} = {}): Promise<ListObjectsResult> {
		this.calls.push('listObjects');
		this.failIfForced();
		const prefix = request.prefix ?? '';
		const all = [...this.objects.entries()]
			.filter(([key]) => key.startsWith(prefix))
			.map(([key, object]) => ({
				key,
				size: object.size,
				etag: object.etag,
				lastModified: object.updatedAt,
			}))
			.sort((a, b) => (a.key < b.key ? -1 : a.key > b.key ? 1 : 0));

		// Mô phỏng phân trang S3: `continuationToken` = key bắt đầu (exclusive).
		const startIndex = request.continuationToken
			? all.findIndex((entry) => entry.key > request.continuationToken!)
			: 0;
		const from = startIndex < 0 ? all.length : startIndex;
		const maxKeys = request.maxKeys ?? 1000;
		const page = all.slice(from, from + maxKeys);
		const hasMore = from + maxKeys < all.length;
		return {
			objects: page,
			nextContinuationToken: hasMore ? (page[page.length - 1]?.key ?? null) : null,
		};
	}
}
