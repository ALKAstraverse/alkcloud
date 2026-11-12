import { StorageError } from '@alkcloud/storage';

/**
 * Phân loại lỗi storage: do HẠ TẦNG (đáng hoàn lại lượt tải) hay do CLIENT
 * (KHÔNG hoàn — nếu không, client có thể chủ động reset bộ đếm download).
 *
 * Xem SEC-02: trước đây mọi lỗi storage đều hoàn lại lượt tải ⇒ một request
 * `Range: bytes=<ngoài EOF>` (B2 trả 416) làm bộ đếm `maxDownloads` về 0 ⇒
 * share có giới hạn 1 lần tải thực tế tải được vô hạn lần.
 */
export function isServerSideStorageFailure(error: unknown): boolean {
	if (error instanceof StorageError) {
		// Không có status ⇒ lỗi mạng/timeout ⇒ coi là lỗi hạ tầng.
		if (error.status === undefined || error.status === null) return true;
		return error.status >= 500;
	}
	// Lỗi không phải StorageError (ví dụ TypeError do mạng) ⇒ coi là hạ tầng.
	return true;
}
