import {
	AppError,
	MAX_PARTS_PER_REQUEST,
	MAX_PART_COUNT,
	MAX_TOTAL_SIZE,
	uploadCompleteSchema,
	uploadPartPresignSchema,
	uploadSessionCreateSchema,
	UPLOAD_SESSION_TTL_HOURS,
} from '@alkcloud/core';
import { Hono } from 'hono';
import type { AppContext } from '../context.js';
import { recordAudit } from '../lib/audit.js';
import { getIdempotencyKey, idempotencyHash, json, parseJsonBody } from '../lib/http.js';
import { assertCapability, degradationHeaders } from '../lib/quota-guard.js';
import { requireOwner, type AppEnv } from '../middleware/auth.js';

/** Ngưỡng chuyển sang multipart và kích thước part. */
export const MULTIPART_THRESHOLD_BYTES = 100 * 1024 * 1024; // 100MB
export const PART_SIZE_BYTES = 64 * 1024 * 1024; // 64MB => file 50GB cần ≤ 800 part (< 1000)
export const DEFAULT_QUOTA_BYTES = 100 * 1024 * 1024 * 1024;


/**
 * SEC-12: loại bỏ presigned URL khỏi response trước khi lưu vào D1.
 * Presigned URL là bearer credential — không được nằm plaintext trong DB/backup.
 */
export function stripPresignedUrls(response: Record<string, unknown>): Record<string, unknown> {
	const parts = Array.isArray(response.parts) ? response.parts : [];
	return {
		...response,
		parts: parts.map((part) => {
			const item = part as Record<string, unknown>;
			const { url: _url, ...rest } = item;
			return rest;
		}),
	};
}

/**
 * SEC-12: cấp lại presigned URL cho response replay của idempotency.
 * Nếu session không còn hợp lệ ⇒ trả response đã lưu (không có URL) — client
 * sẽ báo lỗi rõ ràng và có thể tạo session mới với Idempotency-Key khác.
 */
async function reissueUploadResponse(
	context: AppContext,
	storedBody: string,
): Promise<string> {
	let parsed: Record<string, unknown>;
	try {
		parsed = JSON.parse(storedBody) as Record<string, unknown>;
	} catch {
		return storedBody;
	}
	const sessionId = typeof parsed.uploadSessionId === 'string' ? parsed.uploadSessionId : null;
	if (!sessionId) return storedBody;

	const session = await context.db.getUploadSession(sessionId);
	if (!session || session.status !== 'OPEN') return storedBody;

	const targets: Array<Record<string, unknown>> = [];
	const partCount = Math.min(session.partCount, MAX_PARTS_PER_REQUEST);
	for (let partNumber = 1; partNumber <= partCount; partNumber++) {
		try {
			if (session.partCount === 1) {
				const target = await context.storage.presignPut({
					key: session.objectKey,
					contentType: session.contentType,
					contentLength: session.totalSize,
					expiresInSeconds: 3600,
				});
				targets.push({
					partNumber: 1,
					url: target.url,
					headers: target.headers,
					expiresAt: target.expiresAt,
				});
			} else {
				const uploadId = typeof parsed.uploadId === 'string' ? parsed.uploadId : null;
				if (!uploadId) return storedBody;
				const target = await context.storage.presignUploadPart({
					key: session.objectKey,
					uploadId,
					partNumber,
					expiresInSeconds: 3600,
				});
				targets.push({
					partNumber,
					url: target.url,
					headers: target.headers,
					expiresAt: target.expiresAt,
				});
			}
		} catch {
			return storedBody;
		}
	}
	return JSON.stringify({ ...parsed, parts: targets });
}

export function createUploadRoutes(context: AppContext): Hono<AppEnv> {
	const app = new Hono<AppEnv>();
	app.use('*', requireOwner(context));

	app.post('/', async (c) => {
		const auth = c.get('auth');
		const mode = c.get('quotaMode');
		assertCapability(mode, 'allowNewUploadSession');

		const body = await parseJsonBody(c.req.raw);
		const parsed = uploadSessionCreateSchema.safeParse(body);
		if (!parsed.success) throw AppError.badRequest('Dữ liệu upload không hợp lệ');
		const input = parsed.data;
		if (input.totalSize > MAX_TOTAL_SIZE) {
			throw new AppError('payload_too_large', 'File vượt giới hạn 50GB');
		}

		const idempotencyKey = getIdempotencyKey(c.req.raw);
		const requestHash = await idempotencyHash(c.req.raw, body);
		if (idempotencyKey && auth) {
			const existing = await context.db.getIdempotency(idempotencyKey);
			if (existing) {
				if (existing.requestHash !== requestHash) {
					throw AppError.conflict('Idempotency-Key đã dùng với payload khác');
				}
				if (existing.responseBody) {
					// SEC-12: replay phải CẤP LẠI presigned URL mới (URL cũ không
					// được lưu trong D1 và có thể đã hết hạn).
					const replay = await reissueUploadResponse(context, existing.responseBody);
					return new Response(replay, {
						status: existing.statusCode ?? 200,
						headers: { 'content-type': 'application/json; charset=utf-8', 'idempotent-replay': '1' },
					});
				}
			}
		}

		const owner = await context.db.getOwner();
		if (!owner) throw AppError.notFound('Owner không tồn tại');
		const quotaBytes = Number((await context.db.getSetting<number>('quotaBytes')) ?? DEFAULT_QUOTA_BYTES);

		// Thư mục đích phải tồn tại và chưa bị xoá — nếu không, file sẽ mồ côi.
		if (input.folderId) {
			const folder = await context.db.getFolder(input.folderId);
			if (!folder || folder.deletedAt) throw AppError.notFound('Thư mục đích không tồn tại');
		}

		// Reserve quota atomically trước khi cấp URL (chống concurrent upload vượt giới hạn).
		const sessionId = `upl_${crypto.randomUUID().replace(/-/g, '').slice(0, 24)}`;
		const reservationId = `qrs_${crypto.randomUUID().replace(/-/g, '').slice(0, 24)}`;
		const now = context.now();
		const reserved = await context.db.reserveQuota(
			{ id: reservationId, ownerId: owner.id, uploadSessionId: sessionId, bytes: input.totalSize, now: now.toISOString() },
			quotaBytes,
		);
		if (!reserved) {
			throw AppError.quota('Đã vượt quota lưu trữ — không thể bắt đầu upload mới', 60);
		}

		const multipart = input.totalSize > MULTIPART_THRESHOLD_BYTES;
		const partCount = multipart ? Math.ceil(input.totalSize / PART_SIZE_BYTES) : 1;
		if (partCount > MAX_PART_COUNT) {
			await context.db.releaseQuota(sessionId, now.toISOString());
			throw AppError.badRequest('Số part vượt giới hạn');
		}
		// fileId + revisionId được cấp TRƯỚC khi tạo upload session ⇒ object key
		// có dạng `objects/{fileId}/{revisionId}` đúng thiết kế (D06):
		// tên file KHÔNG nằm trong key B2 (đổi tên file không cần copy object).
		const fileId = `fil_${crypto.randomUUID().replace(/-/g, '').slice(0, 24)}`;
		const revisionId = crypto.randomUUID();
		const objectKey = `objects/${fileId}/${revisionId}`;
		const expiresAt = new Date(now.getTime() + UPLOAD_SESSION_TTL_HOURS * 60 * 60 * 1000).toISOString();

		try {
			const session = await context.db.createUploadSession({
				id: sessionId,
				fileName: input.fileName,
				folderId: input.folderId,
				contentType: input.contentType,
				totalSize: input.totalSize,
				objectKey,
				fileId,
				revisionId,
				partSize: multipart ? PART_SIZE_BYTES : input.totalSize,
				partCount,
				reservedBytes: input.totalSize,
				now: now.toISOString(),
				expiresAt,
			});

			let response: Record<string, unknown>;
			if (multipart) {
				const upload = await context.storage.createMultipartUpload({ key: objectKey, contentType: input.contentType });
				const firstBatch = Array.from({ length: Math.min(MAX_PARTS_PER_REQUEST, partCount) }, (_, index) => index + 1);
				const targets = [];
				for (const partNumber of firstBatch) {
					const target = await context.storage.presignUploadPart({
						key: objectKey,
						uploadId: upload.uploadId,
						partNumber,
						expiresInSeconds: 3600,
					});
					targets.push({ partNumber, url: target.url, headers: target.headers, expiresAt: target.expiresAt });
				}
				response = {
					uploadSessionId: session.id,
					mode: 'multipart',
					uploadId: upload.uploadId,
					partSize: PART_SIZE_BYTES,
					partCount,
					parts: targets,
				};
			} else {
				const target = await context.storage.presignPut({
					key: objectKey,
					contentType: input.contentType,
					contentLength: input.totalSize,
					expiresInSeconds: 3600,
				});
				response = {
					uploadSessionId: session.id,
					mode: 'single',
					partSize: input.totalSize,
					partCount: 1,
					parts: [{ partNumber: 1, url: target.url, headers: target.headers, expiresAt: target.expiresAt }],
				};
			}

			if (idempotencyKey && auth) {
				// SEC-12: KHÔNG lưu presigned URL vào D1.
				// Presigned PUT là bearer credential (ai có URL đều PUT được object
				// trong TTL) ⇒ không được nằm plaintext trong D1 (và trong mọi
				// backup của D1). Chỉ lưu phần không nhạy cảm; URL được cấp lại
				// khi replay (xem `reissueUploadResponse`).
				await context.db.putIdempotency({
					key: idempotencyKey,
					ownerId: auth.ownerId,
					endpoint: 'POST /api/v1/uploads',
					requestHash,
					statusCode: 201,
					responseBody: JSON.stringify(stripPresignedUrls(response)),
					now: now.toISOString(),
					expiresAt: new Date(now.getTime() + 24 * 60 * 60 * 1000).toISOString(),
				});
			}

			await recordAudit(context, {
				action: 'upload.session.create',
				actor: auth?.email ?? 'unknown',
				targetType: 'upload_session',
				targetId: session.id,
				ip: c.get('clientIp'),
				metadata: { size: input.totalSize, multipart },
			});
			return json(response, 201, degradationHeaders(mode));
		} catch (error) {
			// Dọn session nếu đã tạo: nếu chỉ releaseQuota mà giữ session OPEN,
			// session mồ côi vẫn ghi "đã reserve" nhưng không còn reservation ⇒
			// lệch số liệu quota và session treo tới khi hết hạn.
			await context.db.deleteUploadSession(sessionId);
			await context.db.releaseQuota(sessionId, now.toISOString());
			throw error;
		}
	});

	app.get('/:id', async (c) => {
		const session = await context.db.getUploadSession(c.req.param('id'));
		if (!session) throw AppError.notFound('Không tìm thấy upload session');
		return json({
			uploadSessionId: session.id,
			status: session.status,
			partSize: session.partSize,
			partCount: session.partCount,
			uploadedParts: session.uploadedParts,
			expiresAt: session.expiresAt,
		});
	});

	app.post('/:id/parts', async (c) => {
		const mode = c.get('quotaMode');
		assertCapability(mode, 'allowPresignMoreParts');
		const session = await context.db.getUploadSession(c.req.param('id'));
		if (!session) throw AppError.notFound('Không tìm thấy upload session');
		if (session.status !== 'OPEN') throw AppError.conflict('Upload session không còn mở');
		const body = await parseJsonBody(c.req.raw);
		const parsed = uploadPartPresignSchema.safeParse(body);
		if (!parsed.success) throw AppError.badRequest('Danh sách part không hợp lệ');

		const uploadId = parsed.data.uploadId;
		if (!uploadId) throw AppError.badRequest('Thiếu uploadId');
		const parts = [];
		for (const partNumber of parsed.data.partNumbers) {
			if (partNumber > session.partCount) throw AppError.badRequest('partNumber vượt quá partCount');
			const target = await context.storage.presignUploadPart({
				key: session.objectKey,
				uploadId,
				partNumber,
				expiresInSeconds: 3600,
			});
			parts.push({ partNumber, url: target.url, headers: target.headers, expiresAt: target.expiresAt });
		}
		return json({ parts }, 200, degradationHeaders(mode));
	});

	/**
	 * PUT nội dung part qua API (proxy tới B2 qua relay).
	 *
	 * VÌ SAO CẦN:
	 *   Browser không PUT thẳng được vào B2 nếu CSP của Cloudflare **edge** không
	 *   khai báo host B2 trong `connect-src` (edge ghi đè header của Worker ⇒
	 *   Worker không tự sửa được) ⇒ fetch tới presigned URL bị chặn ⇒
	 *   "Failed to fetch". Đường này giữ browser→API (đã có trong `connect-src`)
	 *   rồi API chuyển tiếp qua relay 2-hop tới B2.
	 *
	 * AN TOÀN:
	 *   - API **tự ký** presigned URL từ `session.objectKey` ⇒ presigned URL
	 *     (bearer credential) KHÔNG BAO GIỜ đi qua mạng từ browser → API, và không
	 *     xuất hiện trong query string / log của Cloudflare.
	 *   - Client chỉ gửi `partNumber` + `uploadId` (multipart) — không đủ để PUT
	 *     vào B2 nếu không có secret key.
	 *   - Body được stream thẳng (không buffer, không hash) ⇒ không tốn CPU.
	 */
	// Nhận cả PUT và POST: `PUT` là ngữ nghĩa đúng, `POST` là phương án dự phòng
	// cho trình duyệt — Cloudflare edge có thể giới hạn `Access-Control-Allow-Methods`
	// (đã gặp: edge chỉ cho `GET, POST, PATCH, DELETE, OPTIONS` ⇒ Chrome chặn PUT
	// ngay sau preflight). Client dùng POST; PUT giữ lại cho server-to-server.
	app.on(['POST', 'PUT'], '/:id/content', async (c) => {
		const session = await context.db.getUploadSession(c.req.param('id'));
		if (!session) throw AppError.notFound('Không tìm thấy upload session');
		if (session.status !== 'OPEN') throw AppError.conflict('Upload session không còn mở');
		if (Date.parse(session.expiresAt) <= context.now().getTime()) {
			throw AppError.conflict('Upload session đã hết hạn');
		}

		const relayUrl = context.config.b2.relayUrl;
		const relayToken = context.config.b2.relayToken;
		if (!relayUrl || !relayToken) throw AppError.notConfigured('Relay B2 chưa cấu hình');

		// Chế độ do server quyết định (session.partCount), không tin payload client.
		let target: { url: string; headers: Record<string, string> };
		if (session.partCount === 1) {
			const presigned = await context.storage.presignPut({
				key: session.objectKey,
				contentType: session.contentType,
				contentLength: session.totalSize,
				expiresInSeconds: 3600,
			});
			target = presigned;
		} else {
			const partNumber = Number(c.req.query('partNumber'));
			const uploadId = c.req.query('uploadId');
			if (!Number.isInteger(partNumber) || partNumber < 1 || partNumber > session.partCount) {
				throw AppError.badRequest('partNumber không hợp lệ');
			}
			if (!uploadId) throw AppError.badRequest('Thiếu uploadId');
			target = await context.storage.presignUploadPart({
				key: session.objectKey,
				uploadId,
				partNumber,
				expiresInSeconds: 3600,
			});
		}

		const headers: Record<string, string> = {
			'x-alkcloud-target': target.url,
			'x-alkcloud-relay-token': relayToken,
		};
		const contentType = c.req.header('content-type');
		if (contentType) headers['content-type'] = contentType;

		const upstream = await fetch(relayUrl, {
			method: 'PUT',
			headers,
			body: c.req.raw.body,
			duplex: 'half',
		} as RequestInit);

		const etag = upstream.headers.get('etag');
		return new Response(upstream.body, {
			status: upstream.status,
			headers: {
				...(etag ? { etag } : {}),
				// Browser đọc header ETag cross-origin chỉ khi được expose.
				// (CORS ở edge không set header này.)
				'access-control-expose-headers': 'ETag',
				'cache-control': 'no-store',
			},
		});
	});

	app.post('/:id/complete', async (c) => {
		const auth = c.get('auth');
		const mode = c.get('quotaMode');
		// complete LUÔN được phép kể cả khi degraded (D18) để không mất dữ liệu.
		assertCapability(mode, 'allowCompleteUpload');
		const session = await context.db.getUploadSession(c.req.param('id'));
		if (!session) throw AppError.notFound('Không tìm thấy upload session');
		if (session.status !== 'OPEN') throw AppError.conflict('Upload session không còn mở');

		const body = await parseJsonBody(c.req.raw);
		const parsed = uploadCompleteSchema.safeParse(body);
		if (!parsed.success) throw AppError.badRequest('Dữ liệu complete không hợp lệ');
		const uploadId = parsed.data.uploadId;

		// Single-part: object đã được PUT thẳng lên B2, không có multipart upload.
		// Multipart: B2 ListParts là source of truth — không tin tuyệt đối ETag do client gửi.
		// Chế độ được quyết định bởi `session.partCount` (server state), KHÔNG phải payload client.
		let completedEtag: string | null = null;
		let completedSize: number | null = null;
		let uploadedPartCount = 0;
		if (session.partCount === 1) {
			const stat = await context.storage.headObject(session.objectKey);
			if (!stat) throw AppError.badRequest('Object chưa được upload lên B2');
			if (stat.size !== session.totalSize) {
				throw AppError.badRequest(
					`Kích thước object không khớp (B2: ${stat.size}, dự kiến: ${session.totalSize})`,
				);
			}
			completedEtag = stat.etag;
			completedSize = stat.size;
			uploadedPartCount = 1;
		} else {
			if (!uploadId) throw AppError.badRequest('Thiếu uploadId');
			if (parsed.data.parts.length === 0) throw AppError.badRequest('Thiếu danh sách part');
			const remoteParts = await context.storage.listParts({ key: session.objectKey, uploadId });
			if (remoteParts.length !== session.partCount) {
				throw AppError.badRequest(
					`Số part đã upload không khớp (B2: ${remoteParts.length}, cần: ${session.partCount})`,
				);
			}
			const remoteByNumber = new Map(remoteParts.map((part) => [part.partNumber, part]));
			for (const part of parsed.data.parts) {
				const remote = remoteByNumber.get(part.partNumber);
				if (!remote) throw AppError.badRequest(`Part ${part.partNumber} chưa được upload lên B2`);
			}
			// Hoàn tất bằng ETag do B2 trả về (ListParts) — không dùng ETag client gửi lên.
			const completed = await context.storage.completeMultipartUpload({
				key: session.objectKey,
				uploadId,
				parts: remoteParts,
			});
			completedEtag = completed.etag;
			completedSize = completed.size;
			uploadedPartCount = remoteParts.length;
		}

		const now = context.now().toISOString();
		// Thư mục đích có thể đã bị xoá (vào trash) trong lúc upload đang chạy ⇒
		// file sẽ mồ côi (không truy cập được nhưng vẫn tính quota). Chặn lại.
		if (session.folderId) {
			const folder = await context.db.getFolder(session.folderId);
			if (!folder || folder.deletedAt) {
				throw AppError.conflict(
					'Thư mục đích đã bị xoá — hãy huỷ upload và tải lại vào thư mục khác',
				);
			}
		}
		// Giành session atomic: hai request complete đồng thời thì chỉ một đi tiếp,
		// request thua nhận 409 (không tạo 2 file / ghi đè lẫn nhau).
		const claimed = await context.db.claimUploadSession(session.id, now);
		if (!claimed) throw AppError.conflict('Upload session đã được xử lý');
		// Dùng lại fileId/revisionId đã cấp lúc tạo session ⇒ object key giữ nguyên
		// dạng `objects/{fileId}/{revisionId}` và không phụ thuộc tên file.
		let file;
		try {
			file = await context.db.createFile({
			id: session.fileId ?? `fil_${crypto.randomUUID().replace(/-/g, '').slice(0, 24)}`,
			folderId: session.folderId,
			name: session.fileName,
			size: session.totalSize,
			contentType: session.contentType,
			objectKey: session.objectKey,
			revisionId: session.revisionId ?? crypto.randomUUID(),
			etag: completedEtag,
			checksumSha256: parsed.data.checksumSha256 ?? null,
			now,
		});
		} catch (error) {
			// Trùng tên file trong thư mục đích => 409; trả session về OPEN để client
			// đổi tên/thư mục rồi complete lại (object đã upload vẫn dùng được).
			await context.db.reopenUploadSession(session.id, context.now().toISOString());
			const raw = error instanceof Error ? error.message : String(error);
			if (/UNIQUE constraint failed/i.test(raw)) {
				throw AppError.conflict(`Đã có file tên "${session.fileName}" trong thư mục này`);
			}
			throw error;
		}
		await context.db.setUploadSessionStatus(session.id, 'COMPLETED', now);
		await context.db.setUploadSessionUploadedParts(session.id, uploadedPartCount, now);
		await context.db.releaseQuota(session.id, now);
		await recordAudit(context, {
			action: 'file.create',
			actor: auth?.email ?? 'unknown',
			targetType: 'file',
			targetId: file.id,
			ip: c.get('clientIp'),
			metadata: { size: file.size, uploadSessionId: session.id, multipart: session.partCount > 1 },
		});
		return json({ file, mode, size: completedSize }, 201, degradationHeaders(mode));
	});

	app.delete('/:id', async (c) => {
		const auth = c.get('auth');
		const mode = c.get('quotaMode');
		const session = await context.db.getUploadSession(c.req.param('id'));
		if (!session) throw AppError.notFound('Không tìm thấy upload session');
		if (session.status === 'COMPLETED') {
			// Session đã hoàn tất ⇒ file đã tồn tại, không được ghi đè thành ABORTED.
			throw AppError.conflict('Upload session đã hoàn tất');
		}
		const body = (await c.req.json().catch(() => ({}))) as { uploadId?: string };
		if (body.uploadId) {
			try {
				await context.storage.abortMultipartUpload({ key: session.objectKey, uploadId: body.uploadId });
			} catch {
				// Không abort được multipart: để B2 lifecycle dọn (daysFromStartingToCancelingUnfinishedLargeFiles).
			}
		}
		const now = context.now().toISOString();
		await context.db.setUploadSessionStatus(session.id, 'ABORTED', now);
		await context.db.releaseQuota(session.id, now);
		await recordAudit(context, {
			action: 'upload.session.abort',
			actor: auth?.email ?? 'unknown',
			targetType: 'upload_session',
			targetId: session.id,
			ip: c.get('clientIp'),
		});
		return json({ ok: true, mode }, 200, degradationHeaders(mode));
	});

	return app;
}
