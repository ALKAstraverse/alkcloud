import { z } from 'zod';

export const MAX_NAME_LENGTH = 255;
export const MAX_TOTAL_SIZE = 50 * 1024 * 1024 * 1024; // 50GB
export const DEFAULT_QUOTA_BYTES = 100 * 1024 * 1024 * 1024; // 100GB
export const MAX_PARTS_PER_REQUEST = 20;
export const MAX_PART_COUNT = 1_000;
export const PRESIGNED_URL_TTL_SECONDS = 300; // 5 phút
export const TRASH_RETENTION_DAYS = 30;
export const DEFAULT_SHARE_TTL_DAYS = 7;
export const SESSION_TTL_DAYS = 30;
export const UPLOAD_SESSION_TTL_HOURS = 24;

export const nameSchema = z
	.string()
	.min(1, 'tên không được rỗng')
	.max(MAX_NAME_LENGTH)
	.refine((value) => !value.includes('/') && !value.includes('\\'), 'tên chứa ký tự phân tách không hợp lệ')
	.refine((value) => value !== '.' && value !== '..', 'tên không hợp lệ')
	.refine((value) => value.trim().length > 0, 'tên không được rỗng');

export const idSchema = z.string().min(1).max(128);

export const bootstrapSchema = z.object({
	setupToken: z.string().min(16).max(256),
	email: z.email().max(254),
	/** Output của Argon2id phía client (base64url) — KHÔNG phải mật khẩu gốc. */
	authKey: z.string().min(16).max(256),
	authVerifierSalt: z.string().min(8).max(128),
	authParams: z.string().min(8).max(256),
});

export const loginSchema = z.object({
	email: z.email().max(254),
	authKey: z.string().min(16).max(256),
});

export const recoveryLoginSchema = z.object({
	email: z.email().max(254),
	code: z.string().min(8).max(64),
});

export const changePasswordSchema = z.object({
	currentAuthKey: z.string().min(16).max(256),
	newAuthKey: z.string().min(16).max(256),
	newAuthVerifierSalt: z.string().min(8).max(128),
	newAuthParams: z.string().min(8).max(256),
});

export const folderCreateSchema = z.object({
	parentId: idSchema.nullable().default(null),
	name: nameSchema,
});

export const renameSchema = z.object({
	name: nameSchema,
	version: z.number().int().nonnegative().optional(),
});

export const moveSchema = z.object({
	parentId: idSchema.nullable(),
	version: z.number().int().nonnegative().optional(),
});

/**
 * Di chuyển FILE — dùng `folderId` (khác `moveSchema` của thư mục dùng `parentId`).
 *
 * `folderId` là BẮT BUỘC (nullable = đưa về gốc): nếu thiếu ⇒ 400.
 * Trước đây route đọc `body.folderId ?? null` ⇒ body rỗng / sai key (`targetFolderId`)
 * khiến file **lặng lẽ** bị chuyển về thư mục gốc — thao tác sai nhưng trả 200.
 */
export const fileMoveSchema = z.object({
	folderId: idSchema.nullable(),
	version: z.number().int().nonnegative().optional(),
});

export const fileListQuerySchema = z.object({
	parentId: idSchema.nullable().optional(),
	q: z.string().max(200).optional(),
	trashed: z.enum(['true', 'false']).optional(),
	limit: z.coerce.number().int().min(1).max(200).default(100),
	cursor: z.string().max(512).optional(),
});

export const uploadSessionCreateSchema = z.object({
	fileName: nameSchema,
	contentType: z.string().min(1).max(255).default('application/octet-stream'),
	totalSize: z.number().int().min(1).max(MAX_TOTAL_SIZE),
	checksumSha256: z.string().regex(/^[0-9a-f]{64}$/).nullable().default(null),
	/** Thư mục đích — null = root. */
	folderId: idSchema.nullable().default(null),
});

export const uploadPartPresignSchema = z.object({
	uploadId: z.string().min(1).max(128),
	partNumbers: z
		.array(z.number().int().min(1).max(MAX_PART_COUNT))
		.min(1)
		.max(MAX_PARTS_PER_REQUEST),
});

export const uploadCompleteSchema = z.object({
	/**
	 * Chỉ multipart mới cần danh sách part.
	 * Upload single-part đã PUT trực tiếp bằng presigned PUT nên không có `parts`.
	 */
	parts: z
		.array(
			z.object({
				partNumber: z.number().int().min(1).max(MAX_PART_COUNT),
				etag: z.string().min(1).max(256),
				size: z.number().int().min(0),
			}),
		)
		.max(MAX_PART_COUNT)
		.default([]),
	uploadId: z.string().min(1).max(256).optional(),
	checksumSha256: z.string().regex(/^[0-9a-f]{64}$/).nullable().default(null),
});

export const shareCreateSchema = z.object({
	fileId: idSchema,
	expiresInDays: z.number().int().min(1).max(90).default(DEFAULT_SHARE_TTL_DAYS),
	maxDownloads: z.number().int().min(1).max(10_000).nullable().default(null),
	passwordVerifier: z.string().regex(/^[0-9a-f]{64}$/).nullable().default(null),
	passwordSalt: z.string().min(8).max(128).nullable().default(null),
	passwordParams: z.string().min(8).max(256).nullable().default(null),
});

export const shareUpdateSchema = z.object({
	expiresInDays: z.number().int().min(1).max(90).optional(),
	maxDownloads: z.number().int().min(1).max(10_000).nullable().optional(),
});

export const shareUnlockSchema = z.object({
	passwordVerifier: z.string().regex(/^[0-9a-f]{64}$/).optional(),
});

export const settingsUpdateSchema = z.object({
	quotaBytes: z.number().int().min(1024 * 1024).max(DEFAULT_QUOTA_BYTES).optional(),
	alertWebhookUrl: z.url().max(500).optional(),
});

export type BootstrapInput = z.infer<typeof bootstrapSchema>;
export type LoginInput = z.infer<typeof loginSchema>;
export type FolderCreateInput = z.infer<typeof folderCreateSchema>;
export type UploadSessionCreateInput = z.infer<typeof uploadSessionCreateSchema>;
export type UploadCompleteInput = z.infer<typeof uploadCompleteSchema>;
export type ShareCreateInput = z.infer<typeof shareCreateSchema>;
export type ShareUpdateInput = z.infer<typeof shareUpdateSchema>;
export type FileListQuery = z.infer<typeof fileListQuerySchema>;

/**
 * Zod 4 compile lazy: lần parse đầu tiên của mỗi schema tốn ~0.5–2.3ms.
 * Trên Workers Free (CPU 10ms/request) chi phí này rơi vào request đầu tiên
 * của mỗi isolate ⇒ rủi ro chạm trần CPU.
 *
 * Hàm này ép compile toàn bộ schema **một lần lúc Worker khởi động** (giới hạn
 * startup 1 giây, rộng hơn nhiều) để mọi request sau đó chỉ trả giá parse thuần.
 *
 * Gọi ở global scope của `apps/api/src/index.ts`. Idempotent — gọi lại vô hại.
 */
export function warmUpSchemas(): void {
	const schemas: { safeParse: (value: unknown) => unknown }[] = [
		bootstrapSchema,
		loginSchema,
		recoveryLoginSchema,
		changePasswordSchema,
		folderCreateSchema,
		renameSchema,
		moveSchema,
		fileListQuerySchema,
		uploadSessionCreateSchema,
		uploadPartPresignSchema,
		uploadCompleteSchema,
		shareCreateSchema,
		shareUpdateSchema,
		shareUnlockSchema,
		settingsUpdateSchema,
		nameSchema,
		idSchema,
	];
	for (const schema of schemas) {
		try {
			schema.safeParse(undefined);
		} catch {
			// Schema hỏng là lỗi lập trình — nhưng warm-up không được làm hỏng startup.
		}
	}
}
