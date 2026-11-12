/**
 * AlkCloud — lõi kiểm tra tính nhất quán giữa D1 (metadata) và B2 (object).
 *
 * Thiết kế: mọi hàm ở đây là **hàm thuần** (pure) — nhận snapshot, trả về phát hiện.
 * Nhờ vậy có thể test bằng dữ liệu lỗi giả lập mà không cần B2/D1 thật.
 *
 * Nguyên tắc an toàn (bất biến):
 * 1. KHÔNG tự xoá object. Mismatch chỉ được **báo cáo** + đề xuất hành động.
 * 2. Mọi object đang được tham chiếu (metadata, trash, share, upload session) đều
 *    được bảo vệ — không bao giờ đề xuất xoá.
 * 3. Phân biệt rõ "thiếu object" (mất dữ liệu — nghiêm trọng) với "object mồ côi"
 *    (rác — nhẹ hơn, nhưng vẫn KHÔNG tự xoá).
 */

/** Metadata của một file từ D1. */
export interface FileMetadata {
	id: string;
	name: string;
	size: number;
	objectKey: string;
	revisionId: string;
	etag: string | null;
	checksumSha256: string | null;
	deletedAt: string | null;
	purgeAfter: string | null;
	folderId: string | null;
}

/** Upload session từ D1 (object có thể đã tồn tại nếu client PUT xong nhưng chưa complete). */
export interface UploadSessionMetadata {
	id: string;
	fileName: string;
	objectKey: string;
	status: string;
	totalSize: number;
	expiresAt: string;
	fileId: string | null;
}

/** Share từ D1. */
export interface ShareMetadata {
	id: string;
	fileId: string;
	revokedAt: string | null;
	expiresAt: string;
}

/** Object trong B2. */
export interface StorageObject {
	key: string;
	size: number;
	etag: string | null;
	lastModified: string | null;
}

/**
 * Snapshot toàn bộ trạng thái cần đối chiếu.
 *
 * `storageChecked = false` ⇒ chỉ có metadata D1, CHƯA list được B2.
 * Khi đó KHÔNG được phát hiện `missing_object` / `size_mismatch` / `etag_mismatch`
 * / `orphan_object` — nếu không sẽ báo critical giả (B2 chưa kiểm tra ≠ mất dữ liệu).
 */
export interface IntegritySnapshot {
	files: FileMetadata[];
	uploadSessions: UploadSessionMetadata[];
	shares: ShareMetadata[];
	objects: StorageObject[];
	/** Mặc định true. false ⇒ bỏ qua toàn bộ phát hiện phụ thuộc B2. */
	storageChecked?: boolean;
}

export type FindingKind =
	| 'missing_object'
	| 'orphan_object'
	| 'size_mismatch'
	| 'etag_mismatch'
	| 'metadata_missing'
	| 'orphan_upload_session'
	| 'orphan_share'
	| 'stale_upload_session'
	| 'checksum_missing'
	| 'trash_protected';

export type FindingSeverity = 'critical' | 'high' | 'medium' | 'low' | 'info';

export interface IntegrityFinding {
	kind: FindingKind;
	severity: FindingSeverity;
	/** Đối tượng liên quan (file id, object key, session id...). */
	subject: string;
	/** Mô tả chi tiết, KHÔNG chứa secret. */
	detail: string;
	/** Hành động đề xuất — KHÔNG tự thực hiện. */
	suggestion: string;
	/** True nếu đối tượng đang được bảo vệ (trash 30 ngày / share còn hiệu lực). */
	protected: boolean;
}

/** Kết quả audit. */
export interface IntegrityReport {
	generatedAt: string;
	counts: {
		files: number;
		activeFiles: number;
		trashedFiles: number;
		uploadSessions: number;
		shares: number;
		objects: number;
	};
	findings: IntegrityFinding[];
	summary: Record<FindingSeverity, number>;
	/** false ⇒ phần B2 chưa được kiểm tra (chỉ audit metadata D1). */
	storageChecked: boolean;
	/** Tổng số byte metadata kỳ vọng vs thực tế trên B2. */
	bytes: { expectedFromMetadata: number; actualInStorage: number; delta: number };
}

/** Chuẩn hoá ETag: B2 trả `"abc"` (có quote), D1 có thể lưu không quote. */
export function normalizeEtag(value: string | null | undefined): string | null {
	if (!value) return null;
	return value.replace(/^"|"$/g, '').trim() || null;
}

/**
 * Object key hợp lệ theo thiết kế D06: `objects/{fileId}/{revisionId}`.
 * Key không đúng dạng này là dấu hiệu dữ liệu từ phiên bản cũ hoặc rác.
 */
export function parseObjectKey(key: string): { fileId: string; revisionId: string } | null {
	const match = /^objects\/([^/]+)\/([^/]+)$/.exec(key);
	if (!match?.[1] || !match[2]) return null;
	return { fileId: match[1], revisionId: match[2] };
}

/**
 * Đối chiếu snapshot D1 + B2.
 *
 * @param nowIso - thời điểm dùng để đánh giá session hết hạn (context clock).
 */
export function diffStorage(snapshot: IntegritySnapshot, nowIso: string): IntegrityReport {
	const findings: IntegrityFinding[] = [];
	const now = Date.parse(nowIso);
	const storageChecked = snapshot.storageChecked !== false;

	const objectsByKey = new Map<string, StorageObject>();
	for (const object of snapshot.objects) objectsByKey.set(object.key, object);

	// Object nào đang được tham chiếu bởi metadata / trash / share / upload session.
	const referencedKeys = new Set<string>();
	for (const file of snapshot.files) referencedKeys.add(file.objectKey);
	for (const session of snapshot.uploadSessions) referencedKeys.add(session.objectKey);

	const filesByKey = new Map<string, FileMetadata>();
	for (const file of snapshot.files) filesByKey.set(file.objectKey, file);

	// ---------------------------------------------------------------- 1. File → object
	for (const file of snapshot.files) {
		const object = objectsByKey.get(file.objectKey);
		const isTrashed = file.deletedAt !== null;
		const inTrashProtection = isTrashed && file.purgeAfter !== null && Date.parse(file.purgeAfter) > now;

		if (!object && !storageChecked) {
			// Chưa kiểm tra B2 ⇒ KHÔNG kết luận "mất dữ liệu".
			continue;
		}
		if (!object) {
			findings.push({
				kind: 'missing_object',
				severity: 'critical',
				subject: file.id,
				detail: `Metadata có nhưng object "${file.objectKey}" KHÔNG tồn tại trên B2 (file "${file.name}", ${file.size} byte).`,
				suggestion:
					'KHÔNG tự tạo lại object. Kiểm tra restore backup D1 + backup B2; nếu file còn trong trash, chờ tới purgeAfter rồi purge hoặc restore từ backup.',
				protected: inTrashProtection,
			});
			continue;
		}

		// Kích thước khác nhau ⇒ metadata sai hoặc object bị ghi đè.
		if (object.size !== file.size) {
			findings.push({
				kind: 'size_mismatch',
				severity: 'high',
				subject: file.id,
				detail: `Kích thước lệch: D1 ghi ${file.size} byte, B2 thực tế ${object.size} byte (object "${file.objectKey}").`,
				suggestion:
					'Đây là dấu hiệu object bị ghi đè ngoài ý muốn hoặc metadata sai. KHÔNG tự sửa; so sánh ETag/checksum và backup.',
				protected: inTrashProtection,
			});
		}

		// ETag khác nhau (bỏ qua khi ETag nhiều phần "d-N" của multipart).
		const metaEtag = normalizeEtag(file.etag);
		const objectEtag = normalizeEtag(object.etag);
		if (metaEtag && objectEtag && metaEtag !== objectEtag && !/-[0-9]+$/.test(metaEtag)) {
			findings.push({
				kind: 'etag_mismatch',
				severity: 'high',
				subject: file.id,
				detail: `ETag lệch: D1 "${metaEtag}" vs B2 "${objectEtag}" (object "${file.objectKey}").`,
				suggestion: 'Xác nhận revision nào là đúng; nếu revision trong D1 sai thì cần quyết định khôi phục thủ công.',
				protected: inTrashProtection,
			});
		}

		// Object không có checksum SHA-256 ⇒ không thể xác minh nội dung.
		if (file.checksumSha256 === null && file.size > 0) {
			findings.push({
				kind: 'checksum_missing',
				severity: 'info',
				subject: file.id,
				detail: `File "${file.name}" không có checksum_sha256 — không thể xác minh toàn vẹn nội dung ngoài size/ETag.`,
				suggestion:
					'Đây là hạn mục đã biết: client chưa gửi checksum. Có thể bổ sung ở phiên bản sau nếu owner đồng ý.',
				protected: inTrashProtection,
			});
		}

		// Revision không khớp với object key ⇒ có thể dùng nhầm revision.
		const parsed = parseObjectKey(file.objectKey);
		if (parsed && parsed.revisionId !== file.revisionId) {
			findings.push({
				kind: 'metadata_missing',
				severity: 'medium',
				subject: file.id,
				detail: `Revision trong metadata "${file.revisionId}" khác revision trong object key "${parsed.revisionId}".`,
				suggestion: 'Kiểm tra logic tạo revision; có thể là dữ liệu từ migration cũ.',
				protected: inTrashProtection,
			});
		}
	}

	// ---------------------------------------------------------------- 2. Object mồ côi
	for (const object of storageChecked ? snapshot.objects : []) {
		if (referencedKeys.has(object.key)) continue;
		const parsed = parseObjectKey(object.key);
		findings.push({
			kind: 'orphan_object',
			severity: 'low',
			subject: object.key,
			detail: `Object "${object.key}" (${object.size} byte) không được metadata nào tham chiếu.`,
			suggestion:
				parsed
					? `Có thể là object của upload session đã hết hạn (fileId=${parsed.fileId}). Xác minh trước khi xoá; mặc định GIỮ.`
					: 'Key không theo dạng objects/{fileId}/{revisionId} — rác hoặc từ phiên bản cũ. Xác minh trước khi xoá; mặc định GIỮ.',
			protected: false,
		});
	}

	// ---------------------------------------------------------------- 3. Upload session
	const activeShareFileIds = new Set(
		snapshot.shares.filter((share) => !share.revokedAt && Date.parse(share.expiresAt) > now).map((s) => s.fileId),
	);
	for (const session of snapshot.uploadSessions) {
		const expired = Date.parse(session.expiresAt) <= now;
		if (session.status === 'OPEN') {
			findings.push({
				kind: expired ? 'stale_upload_session' : 'orphan_upload_session',
				severity: expired ? 'medium' : 'info',
				subject: session.id,
				detail: expired
					? `Upload session "${session.id}" đã hết hạn (${session.expiresAt}) nhưng vẫn OPEN — giữ quota reserved và có thể giữ object mồ côi.`
					: `Upload session "${session.id}" đang OPEN (file "${session.fileName}", hết hạn ${session.expiresAt}).`,
				suggestion: expired
					? 'Cron hourly sẽ dọn session hết hạn + xoá object. Nếu cron không chạy, chạy `npm run db:...`/cron thủ công.'
					: 'Bình thường nếu client đang upload. Nếu session treo > 1h, client nên abort.',
				protected: false,
			});
		}
	}

	// ---------------------------------------------------------------- 4. Share mồ côi
	const fileIds = new Set(snapshot.files.map((file) => file.id));
	for (const share of snapshot.shares) {
		if (!fileIds.has(share.fileId)) {
			findings.push({
				kind: 'orphan_share',
				severity: 'medium',
				subject: share.id,
				detail: `Share "${share.id}" tham chiếu file "${share.fileId}" không tồn tại trong D1.`,
				suggestion:
					'Share sẽ không dùng được (404 khi mở). Có thể do file bị purge — xác minh rồi thu hồi share để dọn.',
				protected: false,
			});
		}
	}

	// ---------------------------------------------------------------- 5. Trash được bảo vệ
	for (const file of snapshot.files) {
		if (!file.deletedAt) continue;
		const purgeAfter = file.purgeAfter ? Date.parse(file.purgeAfter) : Number.NaN;
		if (Number.isNaN(purgeAfter)) {
			findings.push({
				kind: 'trash_protected',
				severity: 'medium',
				subject: file.id,
				detail: `File "${file.name}" trong trash nhưng KHÔNG có purge_after — không bao giờ được purge tự động.`,
				suggestion: 'Đặt purge_after = deletedAt + 30 ngày để giữ đúng chính sách retention.',
				protected: true,
			});
		}
	}

	const expectedBytes = snapshot.files
		.filter((file) => file.deletedAt === null)
		.reduce((sum, file) => sum + file.size, 0);
	const actualBytes = snapshot.objects.reduce((sum, object) => sum + object.size, 0);

	const summary: Record<FindingSeverity, number> = { critical: 0, high: 0, medium: 0, low: 0, info: 0 };
	for (const finding of findings) summary[finding.severity] += 1;

	return {
		generatedAt: nowIso,
		counts: {
			files: snapshot.files.length,
			activeFiles: snapshot.files.filter((file) => file.deletedAt === null).length,
			trashedFiles: snapshot.files.filter((file) => file.deletedAt !== null).length,
			uploadSessions: snapshot.uploadSessions.length,
			shares: snapshot.shares.length,
			objects: snapshot.objects.length,
		},
		findings,
			summary,
		storageChecked,
		bytes: {
			expectedFromMetadata: expectedBytes,
			actualInStorage: actualBytes,
			delta: actualBytes - expectedBytes,
		},
	};
}

/** Phân loại mức độ nghiêm trọng tổng thể — dùng cho exit code. */
export function overallSeverity(report: IntegrityReport): FindingSeverity {
	if (report.summary.critical > 0) return 'critical';
	if (report.summary.high > 0) return 'high';
	if (report.summary.medium > 0) return 'medium';
	if (report.summary.low > 0) return 'low';
	return 'info';
}

/** Exit code: 0 = sạch (chỉ info/low), 1 = medium, 2 = high/critical, 3 = lỗi tool. */
export function exitCodeFor(report: IntegrityReport): number {
	const severity = overallSeverity(report);
	if (severity === 'critical' || severity === 'high') return 2;
	if (severity === 'medium') return 1;
	return 0;
}
