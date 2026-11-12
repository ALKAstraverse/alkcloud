import type {
	AuditAction,
	AuditEvent,
	AuditSeverity,
	DegradationMode,
	FileItem,
	Folder,
	Id,
	Owner,
	Session,
	Share,
	UploadSession,
	UploadStatus,
} from '@alkcloud/core';
import { sha256Hex } from '@alkcloud/core';
import type { SqlDriver } from './driver.js';

type Row = Record<string, unknown>;

const str = (value: unknown): string => String(value ?? '');
const nullableStr = (value: unknown): string | null => (value === null || value === undefined ? null : String(value));
const num = (value: unknown): number => Number(value ?? 0);
const nullableNum = (value: unknown): number | null =>
	value === null || value === undefined ? null : Number(value);

function mapOwner(row: Row): Owner {
	return {
		id: str(row.id),
		email: str(row.email),
		authVerifierHash: str(row.auth_verifier_hash),
		authVerifierSalt: str(row.auth_verifier_salt),
		authParams: str(row.auth_params),
		pepperVersion: num(row.pepper_version),
		createdAt: str(row.created_at),
		updatedAt: str(row.updated_at),
	};
}

function mapSession(row: Row): Session {
	return {
		id: str(row.id),
		ownerId: str(row.owner_id),
		tokenHash: str(row.token_hash),
		csrfSecret: str(row.csrf_secret),
		createdAt: str(row.created_at),
		expiresAt: str(row.expires_at),
		lastSeenAt: str(row.last_seen_at),
		revokedAt: nullableStr(row.revoked_at),
		userAgent: nullableStr(row.user_agent),
	};
}

function mapFolder(row: Row): Folder {
	return {
		id: str(row.id),
		parentId: nullableStr(row.parent_id),
		name: str(row.name),
		nameLower: str(row.name_lower),
		depth: num(row.depth),
		createdAt: str(row.created_at),
		updatedAt: str(row.updated_at),
		deletedAt: nullableStr(row.deleted_at),
		deletedBatchId: nullableStr(row.deleted_batch_id),
		version: num(row.version),
	};
}

function mapFile(row: Row): FileItem {
	return {
		id: str(row.id),
		folderId: nullableStr(row.folder_id),
		name: str(row.name),
		nameLower: str(row.name_lower),
		size: num(row.size),
		contentType: str(row.content_type),
		objectKey: str(row.object_key),
		revisionId: str(row.revision_id),
		etag: nullableStr(row.etag),
		checksumSha256: nullableStr(row.checksum_sha256),
		createdAt: str(row.created_at),
		updatedAt: str(row.updated_at),
		deletedAt: nullableStr(row.deleted_at),
		deletedBatchId: nullableStr(row.deleted_batch_id),
		purgeAfter: nullableStr(row.purge_after),
		version: num(row.version),
	};
}

function mapShare(row: Row): Share {
	return {
		id: str(row.id),
		fileId: str(row.file_id),
		tokenHash: str(row.token_hash),
		passwordHash: nullableStr(row.password_hash),
		passwordSalt: nullableStr(row.password_salt),
		passwordParams: nullableStr(row.password_params),
		expiresAt: str(row.expires_at),
		maxDownloads: nullableNum(row.max_downloads),
		downloadCount: num(row.download_count),
		revokedAt: nullableStr(row.revoked_at),
		createdAt: str(row.created_at),
		updatedAt: str(row.updated_at),
	};
}

function mapUploadSession(row: Row): UploadSession {
	return {
		id: str(row.id),
		fileName: str(row.file_name),
		fileNameLower: str(row.file_name_lower),
		folderId: nullableStr(row.folder_id),
		contentType: str(row.content_type),
		totalSize: num(row.total_size),
		objectKey: str(row.object_key),
		fileId: nullableStr(row.file_id),
		revisionId: nullableStr(row.revision_id),
		partSize: num(row.part_size),
		partCount: num(row.part_count),
		uploadedParts: num(row.uploaded_parts),
		status: str(row.status) as UploadStatus,
		reservedBytes: num(row.reserved_bytes),
		createdAt: str(row.created_at),
		updatedAt: str(row.updated_at),
		expiresAt: str(row.expires_at),
	};
}

export interface OwnerInput {
	id: Id;
	email: string;
	authVerifierHash: string;
	authVerifierSalt: string;
	authParams: string;
	createdAt: string;
}

export interface SessionInput {
	id: Id;
	ownerId: Id;
	tokenHash: string;
	csrfSecret: string;
	createdAt: string;
	expiresAt: string;
	userAgent: string | null;
}

export interface FolderInput {
	id: Id;
	parentId: Id | null;
	name: string;
	depth: number;
	now: string;
}

export interface FileInput {
	id: Id;
	folderId: Id | null;
	name: string;
	size: number;
	contentType: string;
	objectKey: string;
	revisionId: Id;
	etag: string | null;
	checksumSha256: string | null;
	now: string;
}

export interface ShareInput {
	id: Id;
	fileId: Id;
	tokenHash: string;
	passwordHash: string | null;
	passwordSalt: string | null;
	passwordParams: string | null;
	expiresAt: string;
	maxDownloads: number | null;
	now: string;
}

export interface UploadSessionInput {
	id: Id;
	fileName: string;
	folderId: Id | null;
	contentType: string;
	totalSize: number;
	objectKey: string;
	/** fileId dự kiến — dùng lại khi tạo `files` row để object key giữ dạng `objects/{fileId}/{revisionId}`. */
	fileId: Id;
	revisionId: Id;
	partSize: number;
	partCount: number;
	reservedBytes: number;
	now: string;
	expiresAt: string;
}

export interface AuditInput {
	id: Id;
	action: AuditAction;
	severity: AuditSeverity;
	actor: string;
	targetType: string | null;
	targetId: string | null;
	metadata: Record<string, unknown>;
	ip: string | null;
	now: string;
}

export interface ListFilesOptions {
	/**
	 * - `null`  => chỉ file ở root
	 * - `Id`    => chỉ file trong thư mục đó
	 * - `undefined` => mọi thư mục (dùng cho tìm kiếm toàn cục)
	 */
	folderId?: Id | null;
	query?: string;
	limit: number;
	offset: number;
	/**
	 * `false` (mặc định) => chỉ file đang hoạt động.
	 * `true`  => CHỈ file đã xoá (trong thùng rác) — dùng cho màn hình thùng rác.
	 *
	 * Tên cũ `includeDeleted` gợi ý "bao gồm cả file đã xoá" (tức là cả hai nhóm),
	 * nhưng thực tế hành vi là lọc theo nhóm ⇒ dễ dùng sai. Đã đổi tên để rõ nghĩa.
	 */
	deletedOnly?: boolean;
}

export class Database {
	constructor(private readonly driver: SqlDriver) {}

	get sqlDriver(): SqlDriver {
		return this.driver;
	}

	// ---------------------------------------------------------------- owner
	async getOwner(): Promise<Owner | null> {
		const result = await this.driver.query('SELECT * FROM owner LIMIT 1');
		const row = result.rows[0];
		return row ? mapOwner(row) : null;
	}

	async countOwners(): Promise<number> {
		const result = await this.driver.query<{ n: number }>('SELECT COUNT(*) AS n FROM owner');
		return num(result.rows[0]?.n);
	}

	async createOwner(input: OwnerInput): Promise<Owner> {
		await this.driver.run(
			`INSERT INTO owner (id, email, auth_verifier_hash, auth_verifier_salt, auth_params, pepper_version, created_at, updated_at)
			 VALUES (?, ?, ?, ?, ?, 1, ?, ?)`,
			[
				input.id,
				input.email,
				input.authVerifierHash,
				input.authVerifierSalt,
				input.authParams,
				input.createdAt,
				input.createdAt,
			],
		);
		const owner = await this.getOwner();
		if (!owner) throw new Error('owner insert failed');
		return owner;
	}

	async updateOwnerAuth(
		ownerId: Id,
		authVerifierHash: string,
		authVerifierSalt: string,
		authParams: string,
		now: string,
	): Promise<void> {
		await this.driver.run(
			`UPDATE owner SET auth_verifier_hash = ?, auth_verifier_salt = ?, auth_params = ?, updated_at = ? WHERE id = ?`,
			[authVerifierHash, authVerifierSalt, authParams, now, ownerId],
		);
	}

	// -------------------------------------------------------------- sessions
	async createSession(input: SessionInput): Promise<void> {
		await this.driver.run(
			`INSERT INTO sessions (id, owner_id, token_hash, csrf_secret, created_at, expires_at, last_seen_at, revoked_at, user_agent)
			 VALUES (?, ?, ?, ?, ?, ?, ?, NULL, ?)`,
			[
				input.id,
				input.ownerId,
				input.tokenHash,
				input.csrfSecret,
				input.createdAt,
				input.expiresAt,
				input.createdAt,
				input.userAgent,
			],
		);
	}

	async findSessionByTokenHash(tokenHash: string): Promise<Session | null> {
		const result = await this.driver.query('SELECT * FROM sessions WHERE token_hash = ?', [tokenHash]);
		const row = result.rows[0];
		return row ? mapSession(row) : null;
	}

	async touchSession(id: Id, now: string): Promise<void> {
		await this.driver.run('UPDATE sessions SET last_seen_at = ? WHERE id = ?', [now, id]);
	}

	async revokeSession(id: Id, now: string): Promise<void> {
		await this.driver.run('UPDATE sessions SET revoked_at = ? WHERE id = ? AND revoked_at IS NULL', [now, id]);
	}

	async revokeAllSessions(ownerId: Id, now: string, exceptSessionId?: Id): Promise<void> {
		if (exceptSessionId) {
			await this.driver.run(
				'UPDATE sessions SET revoked_at = ? WHERE owner_id = ? AND revoked_at IS NULL AND id != ?',
				[now, ownerId, exceptSessionId],
			);
			return;
		}
		await this.driver.run('UPDATE sessions SET revoked_at = ? WHERE owner_id = ? AND revoked_at IS NULL', [
			now,
			ownerId,
		]);
	}

	async deleteExpiredSessions(now: string): Promise<number> {
		const result = await this.driver.run('DELETE FROM sessions WHERE expires_at <= ?', [now]);
		return result.changes ?? 0;
	}

	async listSessions(ownerId: Id): Promise<Session[]> {
		const result = await this.driver.query('SELECT * FROM sessions WHERE owner_id = ? ORDER BY created_at DESC', [
			ownerId,
		]);
		return result.rows.map(mapSession);
	}

	// -------------------------------------------------------- recovery codes
	async replaceRecoveryCodes(ownerId: Id, codes: { id: Id; codeHash: string }[], now: string): Promise<void> {
		await this.driver.run('DELETE FROM recovery_codes WHERE owner_id = ?', [ownerId]);
		for (const code of codes) {
			await this.driver.run(
				'INSERT INTO recovery_codes (id, owner_id, code_hash, used_at, created_at) VALUES (?, ?, ?, NULL, ?)',
				[code.id, ownerId, code.codeHash, now],
			);
		}
	}

	async countUnusedRecoveryCodes(ownerId: Id): Promise<number> {
		const result = await this.driver.query<{ n: number }>(
			'SELECT COUNT(*) AS n FROM recovery_codes WHERE owner_id = ? AND used_at IS NULL',
			[ownerId],
		);
		return num(result.rows[0]?.n);
	}

	async consumeRecoveryCode(ownerId: Id, codeHash: string, now: string): Promise<boolean> {
		const result = await this.driver.run(
			'UPDATE recovery_codes SET used_at = ? WHERE owner_id = ? AND code_hash = ? AND used_at IS NULL',
			[now, ownerId, codeHash],
		);
		return (result.changes ?? 0) > 0;
	}

	// --------------------------------------------------------------- folders
	async createFolder(input: FolderInput): Promise<Folder> {
		await this.driver.run(
			`INSERT INTO folders (id, parent_id, name, name_lower, depth, created_at, updated_at, deleted_at, deleted_batch_id, version)
			 VALUES (?, ?, ?, ?, ?, ?, ?, NULL, NULL, 1)`,
			[
				input.id,
				input.parentId,
				input.name,
				input.name.toLowerCase(),
				input.depth,
				input.now,
				input.now,
			],
		);
		const folder = await this.getFolder(input.id);
		if (!folder) throw new Error('folder insert failed');
		return folder;
	}

	async getFolder(id: Id): Promise<Folder | null> {
		const result = await this.driver.query('SELECT * FROM folders WHERE id = ?', [id]);
		const row = result.rows[0];
		return row ? mapFolder(row) : null;
	}

	async listFolders(parentId: Id | null, limit = 200, offset = 0): Promise<Folder[]> {
		// SEC-11: luôn có LIMIT — trả về toàn bộ folder có thể vượt giới hạn
		// response/CPU của một Worker invocation.
		if (parentId === null) {
			const result = await this.driver.query(
				'SELECT * FROM folders WHERE parent_id IS NULL AND deleted_at IS NULL ORDER BY name_lower ASC LIMIT ? OFFSET ?',
				[limit, offset],
			);
			return result.rows.map(mapFolder);
		}
		const result = await this.driver.query(
			'SELECT * FROM folders WHERE parent_id = ? AND deleted_at IS NULL ORDER BY name_lower ASC LIMIT ? OFFSET ?',
			[parentId, limit, offset],
		);
		return result.rows.map(mapFolder);
	}

	async renameFolder(id: Id, name: string, now: string): Promise<void> {
		await this.driver.run(
			'UPDATE folders SET name = ?, name_lower = ?, updated_at = ?, version = version + 1 WHERE id = ? AND deleted_at IS NULL',
			[name, name.toLowerCase(), now, id],
		);
	}

	async moveFolder(id: Id, parentId: Id | null, depth: number, now: string): Promise<void> {
		// Phải lấy depth CŨ trước khi update, nếu không delta luôn = 0.
		const previousDepth = await this.getFolderDepth(id);
		await this.driver.run(
			'UPDATE folders SET parent_id = ?, depth = ?, updated_at = ?, version = version + 1 WHERE id = ? AND deleted_at IS NULL',
			[parentId, depth, now, id],
		);
		// Hậu duệ phải cập nhật depth theo delta — nếu không, `depth` của cây con
		// sẽ sai ⇒ check MAX_FOLDER_DEPTH ở các lần create/move sau sẽ tính sai.
		const delta = depth - previousDepth;
		if (delta === 0) return;
		// Trừ chính folder đã update ở trên (`id != ?`) — nếu không nó bị cộng
		// delta thêm lần nữa và depth sai.
		await this.driver.run(
			`UPDATE folders SET depth = depth + ?, updated_at = ?, version = version + 1
			 WHERE id != ? AND id IN (
				WITH RECURSIVE subtree(id) AS (
					SELECT id FROM folders WHERE id = ? AND deleted_at IS NULL
					UNION ALL
					SELECT f.id FROM folders f JOIN subtree s ON f.parent_id = s.id WHERE f.deleted_at IS NULL
				)
				SELECT id FROM subtree
			 ) AND deleted_at IS NULL`,
			[delta, now, id, id],
		);
	}

	async getFolderDepth(id: Id): Promise<number> {
		const result = await this.driver.query<{ depth: number }>('SELECT depth FROM folders WHERE id = ?', [id]);
		return num(result.rows[0]?.depth);
	}

	async softDeleteFolder(id: Id, batchId: Id, now: string): Promise<void> {
		await this.driver.run(
			'UPDATE folders SET deleted_at = ?, deleted_batch_id = ?, updated_at = ?, version = version + 1 WHERE id = ? AND deleted_at IS NULL',
			[now, batchId, now, id],
		);
	}

	/**
	 * Xoá mềm toàn bộ file nằm trong các thư mục cho trước (dùng khi xoá folder).
	 *
	 * Bắt buộc: nếu chỉ xoá mềm folder mà không đụng file, các file con sẽ mồ côi —
	 * vẫn tính vào quota, không xuất hiện trong trash, và KHÔNG BAO GIỜ được purge.
	 */
	async softDeleteFilesInFolders(folderIds: Id[], batchId: Id, purgeAfter: string, now: string): Promise<number> {
		if (folderIds.length === 0) return 0;
		const placeholders = folderIds.map(() => '?').join(', ');
		const result = await this.driver.run(
			`UPDATE files SET deleted_at = ?, deleted_batch_id = ?, purge_after = ?, updated_at = ?, version = version + 1
			 WHERE folder_id IN (${placeholders}) AND deleted_at IS NULL`,
			[now, batchId, purgeAfter, now, ...folderIds],
		);
		return result.changes ?? 0;
	}

	/**
	 * Khôi phục file theo batch (dùng khi khôi phục folder).
	 *
	 * `folderIds` giới hạn phạm vi: khi khôi phục MỘT thư mục con trong subtree,
	 * file của các thư mục anh em (cùng batch) KHÔNG được khôi phục — nếu không,
	 * file đó thành "không xoá nhưng không truy cập được" (folder cha vẫn trong
	 * trash) ⇒ vô hình, vẫn tính quota, KHÔNG BAO GIỜ được purge.
	 */
	async restoreFilesByBatch(batchId: Id, now: string, folderIds?: Id[]): Promise<number> {
		const params: unknown[] = [now, batchId];
		let folderFilter = '';
		if (folderIds && folderIds.length > 0) {
			const placeholders = folderIds.map(() => '?').join(', ');
			folderFilter = ` AND (folder_id IS NULL OR folder_id IN (${placeholders}))`;
			params.push(...folderIds);
		}
		const result = await this.driver.run(
			`UPDATE files SET deleted_at = NULL, deleted_batch_id = NULL, purge_after = NULL, updated_at = ?, version = version + 1
			 WHERE deleted_batch_id = ?${folderFilter}`,
			params,
		);
		return result.changes ?? 0;
	}

	async restoreFolder(id: Id, now: string): Promise<void> {
		await this.driver.run(
			'UPDATE folders SET deleted_at = NULL, deleted_batch_id = NULL, updated_at = ?, version = version + 1 WHERE id = ?',
			[now, id],
		);
	}

	/**
	 * Xoá mềm TOÀN BỘ subtree folder bằng MỘT câu lệnh (recursive CTE).
	 *
	 * SEC-05: trước đây route gọi `softDeleteFolder` cho từng node ⇒ mỗi node là
	 * 1 D1 subrequest. Workers Free chỉ cho 50 subrequest/request ⇒ subtree > ~45
	 * folder làm request chết GIỮA CHỪNG ⇒ một phần folder đã xoá, phần còn lại
	 * chưa ⇒ file bên trong mồ côi (vô hình, vẫn tính quota, KHÔNG BAO GIỜ purge).
	 */
	async softDeleteFolderSubtree(id: Id, batchId: Id, now: string): Promise<number> {
		const result = await this.driver.run(
			`UPDATE folders SET deleted_at = ?, deleted_batch_id = ?, updated_at = ?, version = version + 1
			 WHERE deleted_at IS NULL AND id IN (
				WITH RECURSIVE subtree(id) AS (
					SELECT id FROM folders WHERE id = ?
					UNION ALL
					SELECT f.id FROM folders f JOIN subtree s ON f.parent_id = s.id
				)
				SELECT id FROM subtree
			 )`,
			[now, batchId, now, id],
		);
		return result.changes ?? 0;
	}

	/** Khôi phục TOÀN BỘ subtree folder bằng MỘT câu lệnh (xem SEC-05). */
	async restoreFolderSubtree(id: Id, now: string): Promise<number> {
		const result = await this.driver.run(
			`UPDATE folders SET deleted_at = NULL, deleted_batch_id = NULL, updated_at = ?, version = version + 1
			 WHERE deleted_at IS NOT NULL AND id IN (
				WITH RECURSIVE subtree(id) AS (
					SELECT id FROM folders WHERE id = ?
					UNION ALL
					SELECT f.id FROM folders f JOIN subtree s ON f.parent_id = s.id
				)
				SELECT id FROM subtree
			 )`,
			[now, id],
		);
		return result.changes ?? 0;
	}

	/** Folder + toàn bộ hậu duệ (dùng cho move/delete/restore theo subtree). */
	async listFolderSubtree(id: Id): Promise<Folder[]> {
		const result = await this.driver.query(
			`WITH RECURSIVE subtree(id) AS (
				SELECT id FROM folders WHERE id = ?
				UNION ALL
				SELECT f.id FROM folders f JOIN subtree s ON f.parent_id = s.id
			)
			SELECT f.* FROM folders f JOIN subtree s ON f.id = s.id ORDER BY f.depth ASC`,
			[id],
		);
		return result.rows.map(mapFolder);
	}

	// ----------------------------------------------------------------- files
	async createFile(input: FileInput): Promise<FileItem> {
		await this.driver.run(
			`INSERT INTO files (id, folder_id, name, name_lower, size, content_type, object_key, revision_id, etag, checksum_sha256,
				created_at, updated_at, deleted_at, deleted_batch_id, purge_after, version)
			 VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, NULL, NULL, NULL, 1)`,
			[
				input.id,
				input.folderId,
				input.name,
				input.name.toLowerCase(),
				input.size,
				input.contentType,
				input.objectKey,
				input.revisionId,
				input.etag,
				input.checksumSha256,
				input.now,
				input.now,
			],
		);
		const file = await this.getFile(input.id);
		if (!file) throw new Error('file insert failed');
		return file;
	}

	async getFile(id: Id): Promise<FileItem | null> {
		const result = await this.driver.query('SELECT * FROM files WHERE id = ?', [id]);
		const row = result.rows[0];
		return row ? mapFile(row) : null;
	}

	async getFileByObjectKey(objectKey: string): Promise<FileItem | null> {
		const result = await this.driver.query('SELECT * FROM files WHERE object_key = ?', [objectKey]);
		const row = result.rows[0];
		return row ? mapFile(row) : null;
	}

	async listFiles(options: ListFilesOptions): Promise<FileItem[]> {
		const clauses: string[] = [];
		const params: unknown[] = [];
		if (options.folderId === null) {
			clauses.push('folder_id IS NULL');
		} else if (options.folderId !== undefined) {
			clauses.push('folder_id = ?');
			params.push(options.folderId);
		}
		clauses.push(options.deletedOnly ? 'deleted_at IS NOT NULL' : 'deleted_at IS NULL');
		if (options.query) {
			clauses.push('name_lower LIKE ?');
			params.push(`%${options.query.toLowerCase()}%`);
		}
		params.push(options.limit, options.offset);
		const result = await this.driver.query(
			`SELECT * FROM files WHERE ${clauses.join(' AND ')} ORDER BY name_lower ASC, id ASC LIMIT ? OFFSET ?`,
			params,
		);
		return result.rows.map(mapFile);
	}

	async renameFile(id: Id, name: string, now: string): Promise<void> {
		await this.driver.run(
			'UPDATE files SET name = ?, name_lower = ?, updated_at = ?, version = version + 1 WHERE id = ? AND deleted_at IS NULL',
			[name, name.toLowerCase(), now, id],
		);
	}

	async moveFile(id: Id, folderId: Id | null, now: string): Promise<void> {
		await this.driver.run(
			'UPDATE files SET folder_id = ?, updated_at = ?, version = version + 1 WHERE id = ? AND deleted_at IS NULL',
			[folderId, now, id],
		);
	}

	async softDeleteFile(id: Id, batchId: Id, purgeAfter: string, now: string): Promise<void> {
		await this.driver.run(
			`UPDATE files SET deleted_at = ?, deleted_batch_id = ?, purge_after = ?, updated_at = ?, version = version + 1
			 WHERE id = ? AND deleted_at IS NULL`,
			[now, batchId, purgeAfter, now, id],
		);
	}

	async restoreFile(id: Id, now: string): Promise<void> {
		await this.driver.run(
			'UPDATE files SET deleted_at = NULL, deleted_batch_id = NULL, purge_after = NULL, updated_at = ?, version = version + 1 WHERE id = ?',
			[now, id],
		);
	}

	async listTrashFolders(limit: number, offset = 0): Promise<Folder[]> {
		const result = await this.driver.query(
			'SELECT * FROM folders WHERE deleted_at IS NOT NULL ORDER BY deleted_at DESC LIMIT ? OFFSET ?',
			[limit, offset],
		);
		return result.rows.map(mapFolder);
	}

	async listTrashFiles(limit: number, offset = 0): Promise<FileItem[]> {
		const result = await this.driver.query(
			'SELECT * FROM files WHERE deleted_at IS NOT NULL ORDER BY deleted_at DESC LIMIT ? OFFSET ?',
			[limit, offset],
		);
		return result.rows.map(mapFile);
	}

	/**
	 * Dọn row folder đã xoá mềm quá hạn retention và không còn file tham chiếu.
	 * Nhờ `ON DELETE CASCADE` trên parent_id, xoá folder cha sẽ dọn luôn cây con.
	 */
	async purgeDeletedFolders(olderThan: string): Promise<number> {
		const result = await this.driver.run(
			`DELETE FROM folders
			 WHERE deleted_at IS NOT NULL AND deleted_at <= ?
			   AND id NOT IN (SELECT folder_id FROM files WHERE folder_id IS NOT NULL)`,
			[olderThan],
		);
		return result.changes ?? 0;
	}

	async listFilesDueForPurge(now: string, limit: number): Promise<FileItem[]> {
		const result = await this.driver.query(
			'SELECT * FROM files WHERE deleted_at IS NOT NULL AND purge_after IS NOT NULL AND purge_after <= ? ORDER BY purge_after ASC LIMIT ?',
			[now, limit],
		);
		return result.rows.map(mapFile);
	}

	async deleteFileRow(id: Id): Promise<void> {
		await this.driver.run('DELETE FROM files WHERE id = ?', [id]);
	}

	/**
	 * Xoá file VĨNH VIỄN chỉ khi nó VẪN đang trong trash và ĐÃ hết hạn purge.
	 *
	 * SEC-09: purge là thao tác phá huỷ — nếu file đã được restore (hoặc hạn purge
	 * bị đổi) trong lúc request đang chạy thì xoá vô điều kiện sẽ **mất file vĩnh viễn**
	 * (object B2 đã xoá, row D1 bị xoá) dù owner vừa khôi phục nó.
	 */
	async deleteFileRowIfStillTrashed(id: Id, now: string): Promise<boolean> {
		const result = await this.driver.run(
			'DELETE FROM files WHERE id = ? AND deleted_at IS NOT NULL AND purge_after IS NOT NULL AND purge_after <= ?',
			[id, now],
		);
		return (result.changes ?? 0) > 0;
	}

	/** Tổng dung lượng file đang hoạt động (chưa xoá). */
	async sumActiveFileBytes(): Promise<number> {
		const result = await this.driver.query<{ total: number }>(
			'SELECT COALESCE(SUM(size), 0) AS total FROM files WHERE deleted_at IS NULL',
		);
		return num(result.rows[0]?.total);
	}

	async countActiveFiles(): Promise<number> {
		const result = await this.driver.query<{ n: number }>(
			'SELECT COUNT(*) AS n FROM files WHERE deleted_at IS NULL',
		);
		return num(result.rows[0]?.n);
	}

	// ---------------------------------------------------------------- shares
	async createShare(input: ShareInput): Promise<Share> {
		await this.driver.run(
			`INSERT INTO shares (id, file_id, token_hash, password_hash, password_salt, password_params, expires_at, max_downloads,
				download_count, revoked_at, created_at, updated_at)
			 VALUES (?, ?, ?, ?, ?, ?, ?, ?, 0, NULL, ?, ?)`,
			[
				input.id,
				input.fileId,
				input.tokenHash,
				input.passwordHash,
				input.passwordSalt,
				input.passwordParams,
				input.expiresAt,
				input.maxDownloads,
				input.now,
				input.now,
			],
		);
		const share = await this.getShareById(input.id);
		if (!share) throw new Error('share insert failed');
		return share;
	}

	async getShareById(id: Id): Promise<Share | null> {
		const result = await this.driver.query('SELECT * FROM shares WHERE id = ?', [id]);
		const row = result.rows[0];
		return row ? mapShare(row) : null;
	}

	async getShareByTokenHash(tokenHash: string): Promise<Share | null> {
		const result = await this.driver.query('SELECT * FROM shares WHERE token_hash = ?', [tokenHash]);
		const row = result.rows[0];
		return row ? mapShare(row) : null;
	}

	async listSharesForFile(fileId: Id, limit = 200, offset = 0): Promise<Share[]> {
		// SEC-11: luôn có LIMIT.
		const result = await this.driver.query(
			'SELECT * FROM shares WHERE file_id = ? ORDER BY created_at DESC LIMIT ? OFFSET ?',
			[fileId, limit, offset],
		);
		return result.rows.map(mapShare);
	}

	async updateShare(
		id: Id,
		patch: { expiresAt?: string; maxDownloads?: number | null },
		now: string,
	): Promise<void> {
		const sets: string[] = [];
		const params: unknown[] = [];
		if (patch.expiresAt !== undefined) {
			sets.push('expires_at = ?');
			params.push(patch.expiresAt);
		}
		if (patch.maxDownloads !== undefined) {
			sets.push('max_downloads = ?');
			params.push(patch.maxDownloads);
		}
		sets.push('updated_at = ?');
		params.push(now, id);
		await this.driver.run(`UPDATE shares SET ${sets.join(', ')} WHERE id = ?`, params);
	}

	async revokeShare(id: Id, now: string): Promise<void> {
		await this.driver.run('UPDATE shares SET revoked_at = ?, updated_at = ? WHERE id = ?', [now, now, id]);
	}

	/** Tăng bộ đếm download theo điều kiện — atomic, trả về false nếu không còn quyền. */
	async incrementShareDownload(id: Id, now: string): Promise<boolean> {
		const result = await this.driver.run(
			`UPDATE shares SET download_count = download_count + 1, updated_at = ?
			 WHERE id = ? AND revoked_at IS NULL AND expires_at > ? AND (max_downloads IS NULL OR download_count < max_downloads)`,
			[now, id, now],
		);
		return (result.changes ?? 0) > 0;
	}

	/**
	 * Hoàn lại 1 lượt tải khi việc đọc object thất bại (B2 lỗi / object mất).
	 * Không để ngưỡng `max_downloads` bị "ăn" mất oan.
	 */
	async decrementShareDownload(id: Id, now: string): Promise<boolean> {
		const result = await this.driver.run(
			`UPDATE shares SET download_count = download_count - 1, updated_at = ?
			 WHERE id = ? AND download_count > 0`,
			[now, id],
		);
		return (result.changes ?? 0) > 0;
	}

	async countActiveShares(fileId: Id, now: string): Promise<number> {
		// Share đã hết hạn cũng phải được tính là "không còn hoạt động" — nếu không,
		// file bị khoá vĩnh viễn vì share hết hạn không bao giờ bị revoke.
		// `now` do caller truyền vào (context clock) — dùng đồng hồ thật sẽ làm
		// test không deterministic và lệch với mốc thời gian của request.
		const result = await this.driver.query<{ n: number }>(
			`SELECT COUNT(*) AS n FROM shares
			 WHERE file_id = ? AND revoked_at IS NULL AND (expires_at IS NULL OR expires_at > ?)`,
			[fileId, now],
		);
		return num(result.rows[0]?.n);
	}

	// ------------------------------------------------------- upload sessions
	async createUploadSession(input: UploadSessionInput): Promise<UploadSession> {
		await this.driver.run(
			`INSERT INTO upload_sessions (id, file_name, file_name_lower, folder_id, content_type, total_size, object_key,
				file_id, revision_id, part_size, part_count, uploaded_parts, status, reserved_bytes, created_at, updated_at, expires_at)
			 VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 0, 'OPEN', ?, ?, ?, ?)`,
			[
				input.id,
				input.fileName,
				input.fileName.toLowerCase(),
				input.folderId,
				input.contentType,
				input.totalSize,
				input.objectKey,
				input.fileId,
				input.revisionId,
				input.partSize,
				input.partCount,
				input.reservedBytes,
				input.now,
				input.now,
				input.expiresAt,
			],
		);
		const session = await this.getUploadSession(input.id);
		if (!session) throw new Error('upload session insert failed');
		return session;
	}

	async getUploadSession(id: Id): Promise<UploadSession | null> {
		const result = await this.driver.query('SELECT * FROM upload_sessions WHERE id = ?', [id]);
		const row = result.rows[0];
		return row ? mapUploadSession(row) : null;
	}

	async setUploadSessionStatus(id: Id, status: UploadStatus, now: string): Promise<void> {
		await this.driver.run('UPDATE upload_sessions SET status = ?, updated_at = ? WHERE id = ?', [status, now, id]);
	}

	/**
	 * Giành quyền xử lý complete một cách atomic (CAS trên status).
	 * Hai request complete đồng thời: chỉ một nhận `true`, request còn lại nhận
	 * `false` ⇒ trả 409 thay vì cùng tạo file/ghi đè.
	 */
	async claimUploadSession(id: Id, now: string): Promise<boolean> {
		const result = await this.driver.run(
			`UPDATE upload_sessions SET status = 'COMPLETING', updated_at = ? WHERE id = ? AND status = 'OPEN'`,
			[now, id],
		);
		return (result.changes ?? 0) > 0;
	}

	/** Trả session về OPEN khi bước complete thất bại (để client thử lại). */
	async reopenUploadSession(id: Id, now: string): Promise<void> {
		await this.driver.run(
			`UPDATE upload_sessions SET status = 'OPEN', updated_at = ? WHERE id = ? AND status = 'COMPLETING'`,
			[now, id],
		);
	}

	async setUploadSessionUploadedParts(id: Id, uploadedParts: number, now: string): Promise<void> {
		await this.driver.run('UPDATE upload_sessions SET uploaded_parts = ?, updated_at = ? WHERE id = ?', [
			uploadedParts,
			now,
			id,
		]);
	}

	/** Tìm upload session OPEN theo object_key (SEC-09 — không quét theo trang). */
	async findOpenUploadSessionByObjectKey(objectKey: string): Promise<UploadSession | null> {
		const result = await this.driver.query(
			"SELECT * FROM upload_sessions WHERE object_key = ? AND status = 'OPEN' LIMIT 1",
			[objectKey],
		);
		const row = result.rows[0];
		return row ? mapUploadSession(row) : null;
	}

	async listOpenUploadSessions(limit: number): Promise<UploadSession[]> {
		const result = await this.driver.query(
			"SELECT * FROM upload_sessions WHERE status = 'OPEN' ORDER BY created_at ASC LIMIT ?",
			[limit],
		);
		return result.rows.map(mapUploadSession);
	}

	async listExpiredUploadSessions(now: string, limit: number): Promise<UploadSession[]> {
		const result = await this.driver.query(
			"SELECT * FROM upload_sessions WHERE status = 'OPEN' AND expires_at <= ? ORDER BY expires_at ASC LIMIT ?",
			[now, limit],
		);
		return result.rows.map(mapUploadSession);
	}

	async deleteUploadSession(id: Id): Promise<void> {
		await this.driver.run('DELETE FROM upload_sessions WHERE id = ?', [id]);
	}

	// ----------------------------------------------------------------- audit
	async appendAudit(input: AuditInput): Promise<AuditEvent> {
		const metadataJson = JSON.stringify(input.metadata ?? {});
		const HEAD_ATTEMPTS = 50;
		let lastError: unknown = null;
		for (let attempt = 0; attempt < HEAD_ATTEMPTS; attempt++) {
			// `audit_chain.prev_hash` là PRIMARY KEY ⇒ hai request đồng thời đọc cùng
			// head sẽ tranh nhau insert; chỉ một thắng, request thua retry với head mới.
			const head = await this.driver.query<{ entry_hash: string }>(
				'SELECT entry_hash FROM audit_chain ORDER BY seq DESC LIMIT 1',
			);
			const prevHash = head.rows[0] ? str(head.rows[0].entry_hash) : 'GENESIS';
			const entryHash = await sha256Hex(
				[
					prevHash,
					input.id,
					input.action,
					input.severity,
					input.actor,
					input.targetType ?? '',
					input.targetId ?? '',
					metadataJson,
					input.ip ?? '',
					input.now,
				].join('|'),
			);
			try {
				// Ghi audit row + head trong CÙNG batch (D1 batch atomic) — tránh
				// trường hợp head tiến mà audit row không được ghi (hoặc ngược lại).
				await this.driver.batch([
					{
						// seq tính trong chính statement (max+1) để tránh đọc-rồi-ghi
						// không atomic; prev_hash là PK nên chỉ 1 request thắng mỗi head.
						sql: `INSERT INTO audit_chain (prev_hash, entry_hash, seq, created_at)
						 VALUES (?, ?, COALESCE((SELECT MAX(seq) FROM audit_chain), 0) + 1, ?)`,
						params: [prevHash, entryHash, input.now],
					},
					{
						sql: `INSERT INTO audit_logs (id, action, severity, actor, target_type, target_id, metadata, ip, created_at, prev_hash, entry_hash)
						 VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
						params: [
							input.id,
							input.action,
							input.severity,
							input.actor,
							input.targetType,
							input.targetId,
							metadataJson,
							input.ip,
							input.now,
							prevHash,
							entryHash,
						],
					},
				]);
				return {
					id: input.id,
					action: input.action,
					severity: input.severity,
					actor: input.actor,
					targetType: input.targetType,
					targetId: input.targetId,
					metadata: input.metadata ?? {},
					ip: input.ip,
					createdAt: input.now,
				};
			} catch (error) {
				lastError = error;
				const raw = error instanceof Error ? error.message : String(error);
				if (!/UNIQUE constraint failed/i.test(raw)) throw error;
			}
		}
		throw lastError ?? new Error('audit chain head conflict');
	}

	/**
	 * Cắt bớt `audit_logs` cũ (SEC-04) — bảng này KHÔNG có retention nên bị
	 * phình vô hạn theo thời gian (mỗi lần đăng nhập sai = 2 row).
	 *
	 * CHỈ xoá `audit_logs`; `audit_chain` được GIỮ NGUYÊN (nó là chuỗi hash
	 * liên kết, xoá entry giữa sẽ đứt chuỗi). Bảng chain nhỏ hơn nhiều
	 * (1 row/event, không có metadata JSON) nên chi phí giữ là chấp nhận được.
	 */
	async pruneAuditLogs(before: string, limit = 500): Promise<number> {
		const result = await this.driver.run(
			`DELETE FROM audit_logs WHERE created_at < ? AND id IN (
				SELECT id FROM audit_logs WHERE created_at < ? ORDER BY created_at ASC LIMIT ?
			)`,
			[before, before, limit],
		);
		return result.changes ?? 0;
	}

	async listAudit(limit: number): Promise<AuditEvent[]> {
		// SEC-10: sắp theo `seq` của audit_chain (thứ tự THẬT của chuỗi hash),
		// không theo created_at + id (id là random ⇒ thứ tự ngẫu nhiên khi trùng
		// milisecond ⇒ báo cáo "chain hỏng" giả).
		const result = await this.driver.query(
			`SELECT l.* FROM audit_logs l
			 LEFT JOIN audit_chain c ON c.entry_hash = l.entry_hash
			 ORDER BY COALESCE(c.seq, -1) DESC, l.created_at DESC, l.id DESC LIMIT ?`,
			[limit],
		);
		return result.rows.map((row) => ({
			id: str(row.id),
			action: str(row.action) as AuditAction,
			severity: str(row.severity) as AuditSeverity,
			actor: str(row.actor),
			targetType: nullableStr(row.target_type),
			targetId: nullableStr(row.target_id),
			metadata: JSON.parse(str(row.metadata) || '{}') as Record<string, unknown>,
			ip: nullableStr(row.ip),
			createdAt: str(row.created_at),
		}));
	}

	// ------------------------------------------------- settings & system state
	async getSetting<T>(key: string): Promise<T | null> {
		const result = await this.driver.query('SELECT value FROM settings WHERE key = ?', [key]);
		const row = result.rows[0];
		return row ? (JSON.parse(str(row.value)) as T) : null;
	}

	async setSetting(key: string, value: unknown, now: string): Promise<void> {
		await this.driver.run(
			`INSERT INTO settings (key, value, updated_at) VALUES (?, ?, ?)
			 ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at`,
			[key, JSON.stringify(value), now],
		);
	}

	async getSystemState<T>(key: string): Promise<T | null> {
		const result = await this.driver.query('SELECT value FROM system_state WHERE key = ?', [key]);
		const row = result.rows[0];
		return row ? (JSON.parse(str(row.value)) as T) : null;
	}

	async setSystemState(key: string, value: unknown, now: string): Promise<void> {
		await this.driver.run(
			`INSERT INTO system_state (key, value, updated_at) VALUES (?, ?, ?)
			 ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at`,
			[key, JSON.stringify(value), now],
		);
	}

	// ---------------------------------------------------------- idempotency
	async getIdempotency(
		key: string,
	): Promise<{ requestHash: string; statusCode: number | null; responseBody: string | null } | null> {
		const result = await this.driver.query(
			'SELECT request_hash, status_code, response_body FROM idempotency_keys WHERE key = ?',
			[key],
		);
		const row = result.rows[0];
		if (!row) return null;
		return {
			requestHash: str(row.request_hash),
			statusCode: nullableNum(row.status_code),
			responseBody: nullableStr(row.response_body),
		};
	}

	async putIdempotency(
		entry: {
			key: string;
			ownerId: Id;
			endpoint: string;
			requestHash: string;
			statusCode: number | null;
			responseBody: string | null;
			now: string;
			expiresAt: string;
		},
	): Promise<void> {
		await this.driver.run(
			`INSERT INTO idempotency_keys (key, owner_id, endpoint, request_hash, status_code, response_body, created_at, expires_at)
			 VALUES (?, ?, ?, ?, ?, ?, ?, ?)
			 ON CONFLICT(key) DO UPDATE SET status_code = excluded.status_code, response_body = excluded.response_body`,
			[
				entry.key,
				entry.ownerId,
				entry.endpoint,
				entry.requestHash,
				entry.statusCode,
				entry.responseBody,
				entry.now,
				entry.expiresAt,
			],
		);
	}

	async deleteExpiredIdempotency(now: string): Promise<number> {
		const result = await this.driver.run('DELETE FROM idempotency_keys WHERE expires_at <= ?', [now]);
		return result.changes ?? 0;
	}

	// ----------------------------------------------------- quota reservation
	/** Tổng bytes đang giữ reservation (đồng thời tính cả session chưa release). */
	async reservedQuotaBytes(ownerId: Id): Promise<number> {
		const result = await this.driver.query<{ total: number }>(
			"SELECT COALESCE(SUM(bytes), 0) AS total FROM quota_reservations WHERE owner_id = ? AND state = 'HELD'",
			[ownerId],
		);
		return num(result.rows[0]?.total);
	}

	/**
	 * Reserve quota atomically: INSERT ... SELECT với điều kiện tổng bytes đang dùng
	 * (file đang hoạt động) + bytes đang giữ (reservation HELD) + bytes mới <= limit.
	 * `changes === 1` => reserve thành công.
	 *
	 * Toàn bộ điều kiện và insert nằm trong CÙNG một statement => D1 chạy statement
	 * trong transaction ⇒ không có race khi hai upload session chạy đồng thời.
	 *
	 * `files.size` của file đang hoạt động cũng phải được tính: nếu chỉ tính
	 * reservation HELD thì sau khi upload hoàn tất (reservation chuyển RELEASED)
	 * quota thực tế sẽ không bao giờ chạm trần ⇒ vượt quota không bị chặn.
	 */
	async reserveQuota(
		entry: { id: Id; ownerId: Id; uploadSessionId: Id | null; bytes: number; now: string },
		limitBytes: number,
	): Promise<boolean> {
		const result = await this.driver.run(
			`INSERT INTO quota_reservations (id, owner_id, upload_session_id, bytes, state, created_at, released_at)
			 SELECT ?, ?, ?, ?, 'HELD', ?, NULL
			 WHERE (SELECT COALESCE(SUM(size), 0) FROM files WHERE deleted_at IS NULL)
			     + (SELECT COALESCE(SUM(bytes), 0) FROM quota_reservations WHERE owner_id = ? AND state = 'HELD')
			     + ? <= ?`,
			[
				entry.id,
				entry.ownerId,
				entry.uploadSessionId,
				entry.bytes,
				entry.now,
				entry.ownerId,
				entry.bytes,
				limitBytes,
			],
		);
		return (result.changes ?? 0) > 0;
	}

	async releaseQuota(uploadSessionId: Id, now: string): Promise<void> {
		await this.driver.run(
			"UPDATE quota_reservations SET state = 'RELEASED', released_at = ? WHERE upload_session_id = ? AND state = 'HELD'",
			[now, uploadSessionId],
		);
	}

	async listHeldReservations(ownerId: Id): Promise<{ id: Id; uploadSessionId: Id | null; bytes: number }[]> {
		const result = await this.driver.query(
			"SELECT id, upload_session_id, bytes FROM quota_reservations WHERE owner_id = ? AND state = 'HELD'",
			[ownerId],
		);
		return result.rows.map((row) => ({
			id: str(row.id),
			uploadSessionId: nullableStr(row.upload_session_id),
			bytes: num(row.bytes),
		}));
	}

	// ----------------------------------------------------------------- usage
	async bumpUsageDaily(day: string, patch: Record<string, number>, now: string): Promise<void> {
		const columns = Object.keys(patch);
		if (columns.length === 0) return;
		const values = columns.map((column) => patch[column] ?? 0);
		await this.driver.run(
			`INSERT INTO usage_daily (day, ${columns.join(', ')}, updated_at) VALUES (?, ${columns.map(() => '?').join(', ')}, ?)
			 ON CONFLICT(day) DO UPDATE SET ${columns.map((column) => `${column} = ${column} + excluded.${column}`).join(', ')}, updated_at = excluded.updated_at`,
			[day, ...values, now],
		);
	}

	async getUsageDaily(day: string): Promise<Record<string, number> | null> {
		const result = await this.driver.query('SELECT * FROM usage_daily WHERE day = ?', [day]);
		const row = result.rows[0];
		return row ? Object.fromEntries(Object.entries(row).map(([key, value]) => [key, num(value)])) : null;
	}
}

export { mapFile, mapFolder, mapShare, mapUploadSession };
export type { DegradationMode };
