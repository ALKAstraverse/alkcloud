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
	/** Tên file dùng khi lưu — mặc định lấy `file.name`. Dùng để tự tránh trùng tên. */
	name?: string;
}

const MAX_PARTS_PER_REQUEST = 20;
const CONCURRENCY = 3;

/**
 * PUT một part THẲNG vào presigned URL của B2 (1 hop: browser → B2).
 *
 * Không có đường proxy qua Worker: body file không bao giờ đi qua API
 * (Worker free chỉ có ~100MB/request và bị tính CPU). API chỉ ký URL + ghi D1.
 *
 * Điều kiện hạ tầng (đã cấu hình, có test):
 *   - CSP `connect-src` cho host B2 (`https://s3.ca-east-006.backblazeb2.com`);
 *   - bucket CORS cho origin `https://cloud.alk.xx.kg`, method PUT, expose `ETag`.
 * Presigned URL được trả trong response `POST /uploads` / `POST /uploads/:id/parts`.
 */
async function putPart(
	target: string,
	headers: Record<string, string> | undefined,
	blob: Blob,
	signal?: AbortSignal,
): Promise<string> {
	let response: Response;
	try {
		response = await fetch(target, {
			method: 'PUT',
			headers: headers ?? {},
			body: blob,
			signal,
		});
	} catch {
		throw new ApiError(0, 'upload_part_failed', 'Không gửi được dữ liệu lên B2');
	}
	if (!response.ok) {
		throw new ApiError(response.status, 'upload_part_failed', `PUT part thất bại (${response.status})`);
	}
	// Bucket CORS phải expose ETag; thiếu header ⇒ không thể complete multipart.
	const etag = response.headers.get('etag');
	if (!etag) {
		throw new ApiError(0, 'upload_part_failed', 'B2 không trả ETag (kiểm tra CORS expose ETag)');
	}
	return etag.replace(/^"|"$/g, '');
}

/**
 * Tạo tên không trùng trong thư mục — giống Nextcloud (`bug.txt` → `bug (1).txt`).
 *
 * Server từ chối trùng tên (409) **sau khi** đã nhận hết dữ liệu ⇒ client phải
 * tự tránh trùng trước khi upload, nếu không người dùng thấy "Thất bại" dù file
 * đã có trong thư mục.
 */
export function uniqueFileName(name: string, taken: Iterable<string>): string {
	const used = new Set<string>();
	for (const item of taken) used.add(item.toLowerCase());
	if (!used.has(name.toLowerCase())) return name;
	const dot = name.lastIndexOf('.');
	const stem = dot > 0 ? name.slice(0, dot) : name;
	const ext = dot > 0 ? name.slice(dot) : '';
	for (let index = 1; index < 1000; index += 1) {
		const candidate = `${stem} (${index})${ext}`;
		if (!used.has(candidate.toLowerCase())) return candidate;
	}
	return `${stem} (${Date.now()})${ext}`;
}

/**
 * Upload 1 file theo 2 chế độ:
 * - single  (< 100MB): 1 presigned PUT.
 * - multipart (>= 100MB): chia part 64MB, presign theo lô 20, PUT song song 3 luồng.
 *
 * Body đi thẳng tới B2 bằng presigned URL (nhanh, 1 hop); nếu bị chặn bởi CSP
 * edge thì fallback qua API — xem `putPart`.
 */
export async function uploadFile(
	file: File,
	options: UploadOptions = {},
): Promise<{ id: string; name: string; size: number }> {
	const fileName = options.name ?? file.name;
	const session = await createUploadSession({
		fileName,
		contentType: file.type || 'application/octet-stream',
		totalSize: file.size,
		folderId: options.folderId ?? null,
	});

	if (session.mode === 'single') {
		const part = session.parts[0];
		if (!part) throw new Error('thiếu URL upload');
		try {
			const etag = await putPart(part.url, part.headers, file, options.signal);
			const completed = await completeUpload(session.uploadSessionId, {
				parts: [{ partNumber: 1, etag, size: file.size }],
			});
			options.onProgress?.({ uploadedBytes: file.size, totalBytes: file.size, partsUploaded: 1, partsTotal: 1 });
			return completed.file;
		} catch (error) {
			// Huỷ session để không rò quota + không chặn session mới (giới hạn 50).
			try {
				await abortUpload(session.uploadSessionId);
			} catch {
				// B2 lifecycle sẽ dọn object treo.
			}
			throw error;
		}
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
