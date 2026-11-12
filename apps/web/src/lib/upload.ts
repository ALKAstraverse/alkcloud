import {
	ApiError,
	abortUpload,
	completeUpload,
	createUploadSession,
	presignUploadParts,
} from './api.js';

export interface UploadProgress {
	uploadedBytes: number;
	totalBytes: number;
	partsUploaded: number;
	partsTotal: number;
}

export interface UploadOptions {
	onProgress?: (progress: UploadProgress) => void;
	signal?: AbortSignal;
	/** Thư mục đích — null = root. */
	folderId?: string | null;
}

const MAX_PARTS_PER_REQUEST = 20;
const CONCURRENCY = 3;

async function putPart(
	url: string,
	headers: Record<string, string> | undefined,
	blob: Blob,
	signal?: AbortSignal,
): Promise<string> {
	const response = await fetch(url, {
		method: 'PUT',
		headers: headers ?? {},
		body: blob,
		signal,
	});
	if (!response.ok) {
		throw new ApiError(response.status, 'upload_part_failed', `PUT part thất bại (${response.status})`);
	}
	// ETag phải được B2 expose qua CORS; nếu không có thì dùng header etag hoặc rỗng.
	const etag = response.headers.get('etag') ?? '';
	return etag.replace(/^"|"$/g, '');
}

/**
 * Upload 1 file theo 2 chế độ:
 * - single  (< 100MB): 1 presigned PUT.
 * - multipart (>= 100MB): chia part 64MB, presign theo lô 20, PUT song song 3 luồng.
 *
 * Mọi request đi thẳng tới B2 — không tốn Worker quota.
 */
export async function uploadFile(
	file: File,
	options: UploadOptions = {},
): Promise<{ id: string; name: string; size: number }> {
	const session = await createUploadSession({
		fileName: file.name,
		contentType: file.type || 'application/octet-stream',
		totalSize: file.size,
		folderId: options.folderId ?? null,
	});

	if (session.mode === 'single') {
		const part = session.parts[0];
		if (!part) throw new Error('thiếu URL upload');
		const etag = await putPart(part.url, part.headers, file, options.signal);
		const completed = await completeUpload(session.uploadSessionId, {
			parts: [{ partNumber: 1, etag, size: file.size }],
		});
		options.onProgress?.({ uploadedBytes: file.size, totalBytes: file.size, partsUploaded: 1, partsTotal: 1 });
		return completed.file;
	}

	const uploadId = session.uploadId;
	if (!uploadId) throw new Error('thiếu uploadId multipart');

	const parts: { partNumber: number; etag: string; size: number }[] = [];
	let uploadedBytes = 0;

	const reportProgress = () => {
		options.onProgress?.({
			uploadedBytes,
			totalBytes: file.size,
			partsUploaded: parts.length,
			partsTotal: session.partCount,
		});
	};

	try {
		const numbers = Array.from({ length: session.partCount }, (_, index) => index + 1);
		for (let offset = 0; offset < numbers.length; offset += MAX_PARTS_PER_REQUEST) {
			const batch = numbers.slice(offset, offset + MAX_PARTS_PER_REQUEST);
			const presigned = await presignUploadParts(session.uploadSessionId, uploadId, batch);

			// Upload song song tối đa CONCURRENCY luồng để giảm thời gian chờ.
			let cursor = 0;
			const workers = Array.from({ length: Math.min(CONCURRENCY, presigned.parts.length) }, async () => {
				while (cursor < presigned.parts.length) {
					const index = cursor;
					cursor += 1;
					const target = presigned.parts[index]!;
					const start = (target.partNumber - 1) * session.partSize;
					const end = Math.min(start + session.partSize, file.size);
					const blob = file.slice(start, end);
					const etag = await putPart(target.url, target.headers, blob, options.signal);
					parts.push({ partNumber: target.partNumber, etag, size: blob.size });
					uploadedBytes += blob.size;
					reportProgress();
				}
			});
			await Promise.all(workers);
		}

		parts.sort((a, b) => a.partNumber - b.partNumber);
		const completed = await completeUpload(session.uploadSessionId, { uploadId, parts });
		return completed.file;
	} catch (error) {
		try {
			await abortUpload(session.uploadSessionId, uploadId);
		} catch {
			// B2 lifecycle sẽ dọn multipart còn treo.
		}
		throw error;
	}
}

/** Upload nhiều file tuần tự (giảm tải băng thông và giữ quota an toàn). */
export async function uploadFiles(
	files: File[],
	options: UploadOptions = {},
): Promise<{ uploaded: number; failed: number; errors: string[] }> {
	let uploaded = 0;
	let failed = 0;
	const errors: string[] = [];
	for (const file of files) {
		try {
			await uploadFile(file, options);
			uploaded += 1;
		} catch (error) {
			failed += 1;
			errors.push(`${file.name}: ${error instanceof Error ? error.message : 'lỗi không xác định'}`);
		}
	}
	return { uploaded, failed, errors };
}
