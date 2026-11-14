import {
	ApiError,
	abortUpload,
	completeUpload,
	createUploadSession,
	presignUploadParts,
	uploadContent,
} from './api.js';

export interface UploadProgress {
	uploadedBytes: number;
	totalBytes: number;
	partsUploaded: number;
	partsTotal: number;
}

export interface UploadFileResult {
	name: string;
	size: number;
	status: 'success' | 'error';
	error?: string;
}

export interface UploadOptions {
	onProgress?: (progress: UploadProgress) => void;
	/** Bắt đầu upload một file (dùng cho hàng đợi upload trong UI). */
	onFileStart?: (file: File) => void;
	/** Tiến độ riêng của từng file. */
	onFileProgress?: (file: File, progress: UploadProgress) => void;
	/** Kết quả của từng file (thành công / thất bại). */
	onFileDone?: (file: File, result: UploadFileResult) => void;
	signal?: AbortSignal;
	/** Thư mục đích — null = root. */
	folderId?: string | null;
}

const MAX_PARTS_PER_REQUEST = 20;
const CONCURRENCY = 3;

/**
 * PUT một part.
 *
 * Hai đường, thử theo thứ tự:
 *   1. Qua API (`/uploads/:id/content`) — API chuyển tiếp tới B2 qua relay.
 *      Đường này không phụ thuộc CSP cho host B2 (chỉ cần `api.alk.xx.kg`).
 *   2. Nếu đường 1 lỗi mạng/5xx ⇒ thử PUT thẳng vào presigned URL của B2
 *      (nhanh hơn, không tốn Worker quota, nhưng chỉ chạy được khi CSP cho
 *      phép host B2).
 *
 * Lý do có đường 2: CSP của Cloudflare edge có thể đang cho phép host B2
 * (sau khi owner sửa Transform Rule) hoặc không — client không nên phụ thuộc
 * vào một cấu hình duy nhất.
 */
async function putPart(
	uploadSessionId: string,
	target: string,
	headers: Record<string, string> | undefined,
	blob: Blob,
	signal?: AbortSignal,
	part?: { partNumber: number; uploadId?: string },
): Promise<string> {
	let response: Response | null = null;
	let firstError: unknown = null;
	try {
		response = await uploadContent(
			uploadSessionId,
			part ? { partNumber: part.partNumber, uploadId: part.uploadId } : {},
			blob,
			headers ?? {},
			signal,
		);
	} catch (error) {
		firstError = error;
	}
	if (!response || response.status >= 500) {
		try {
			const direct = await fetch(target, {
				method: 'PUT',
				headers: headers ?? {},
				body: blob,
				signal,
			});
			if (direct.ok || !response) response = direct;
		} catch (error) {
			if (!response) throw firstError ?? error;
		}
	}
	if (!response) {
		throw new ApiError(0, 'upload_part_failed', 'Không gửi được dữ liệu lên B2');
	}
	if (!response.ok) {
		throw new ApiError(response.status, 'upload_part_failed', `PUT part thất bại (${response.status})`);
	}
	const etag = response.headers.get('etag') ?? '';
	return etag.replace(/^"|"$/g, '');
}

/**
 * Upload 1 file theo 2 chế độ:
 * - single  (< 100MB): 1 presigned PUT.
 * - multipart (>= 100MB): chia part 64MB, presign theo lô 20, PUT song song 3 luồng.
 *
 * Body đi qua API (API chuyển tiếp tới B2 qua relay) vì CSP của Cloudflare edge
 * có thể chặn host B2 trong `connect-src` — xem `putPart`.
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
		const etag = await putPart(session.uploadSessionId, part.url, part.headers, file, options.signal);
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
					const etag = await putPart(
						session.uploadSessionId,
						target.url,
						target.headers,
						blob,
						options.signal,
						{ partNumber: target.partNumber, uploadId },
					);
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

/**
 * Upload nhiều file tuần tự (giảm tải băng thông và giữ quota an toàn).
 *
 * Vẫn giữ nguyên hợp đồng cũ (`uploaded` / `failed` / `errors`) và bổ sung
 * `results` + callback theo từng file cho hàng đợi upload trong UI.
 */
export async function uploadFiles(
	files: File[],
	options: UploadOptions = {},
): Promise<{ uploaded: number; failed: number; errors: string[]; results: UploadFileResult[] }> {
	let uploaded = 0;
	let failed = 0;
	const errors: string[] = [];
	const results: UploadFileResult[] = [];
	for (const file of files) {
		options.onFileStart?.(file);
		try {
			await uploadFile(file, {
				...options,
				onProgress: (progress) => {
					options.onProgress?.(progress);
					options.onFileProgress?.(file, progress);
				},
			});
			uploaded += 1;
			results.push({ name: file.name, size: file.size, status: 'success' });
			options.onFileDone?.(file, { name: file.name, size: file.size, status: 'success' });
		} catch (error) {
			failed += 1;
			const message = error instanceof Error ? error.message : 'lỗi không xác định';
			errors.push(`${file.name}: ${message}`);
			results.push({ name: file.name, size: file.size, status: 'error', error: message });
			options.onFileDone?.(file, { name: file.name, size: file.size, status: 'error', error: message });
		}
	}
	return { uploaded, failed, errors, results };
}
