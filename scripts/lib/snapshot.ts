#!/usr/bin/env node
/**
 * AlkCloud — lấy snapshot D1 + B2 cho công cụ audit/reconcile.
 *
 * READ_ONLY: chỉ đọc D1 (qua `wrangler d1 execute --command`) và B2 (ListObjectsV2).
 * Không ghi, không xoá, không tạo tài nguyên.
 */

import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { B2Storage, type ListObjectsResult, type ObjectStorage } from '../../packages/storage/src/index.js';
import type {
	FileMetadata,
	IntegritySnapshot,
	ShareMetadata,
	StorageObject,
	UploadSessionMetadata,
} from '../../packages/storage/src/integrity.js';

export interface SnapshotTarget {
	/** 'local' | 'remote' */
	scope: 'local' | 'remote';
	databaseName: string;
	databaseId: string;
	bucket: string;
}

/** Đọc database_name/database_id/bucket từ wrangler.toml (không phải secret). */
/**
 * Đường dẫn wrangler.toml — override được bằng `ALKCLOUD_WRANGLER_TOML`.
 *
 * BUG-10 (13/11/2026, Phase 5): guard "database_id còn placeholder" (B6) trước
 * đây chỉ kiểm tra file toml thật của repo. Sau khi production đã điền
 * database_id thật, guard không còn kích hoạt ⇒ test chaos T5 không còn
 * kiểm chứng được hành vi an toàn này. Env override cho phép test dùng
 * fixture cố định mà không phụ thuộc trạng thái production.
 */
export function wranglerTomlPath(): string {
	return process.env.ALKCLOUD_WRANGLER_TOML
		? resolve(process.env.ALKCLOUD_WRANGLER_TOML)
		: resolve('apps/api/wrangler.toml');
}

export function readTarget(scope: 'local' | 'remote'): SnapshotTarget {
	const configPath = wranglerTomlPath();
	if (!existsSync(configPath)) throw new Error(`không tìm thấy ${configPath}`);
	const content = readFileSync(configPath, 'utf8');
	const databaseName = /^database_name\s*=\s*"([^"]+)"/m.exec(content)?.[1];
	const databaseId = /^database_id\s*=\s*"([^"]+)"/m.exec(content)?.[1];
	if (!databaseName || !databaseId) throw new Error('không đọc được database_name/database_id');
	if (scope === 'remote' && /^REPLACE_WITH/.test(databaseId)) {
		throw new Error(
			`database_id "${databaseId}" còn placeholder — chưa có D1 production (B6). Không thể audit remote.`,
		);
	}
	const bucket = process.env.ALKCLOUD_TEST_B2_BUCKET ?? process.env.B2_BUCKET ?? '';
	return { scope, databaseName, databaseId, bucket };
}

/** Chạy 1 câu query D1 và trả về mảng row. READ_ONLY. */
export function queryD1<T = Record<string, unknown>>(
	scope: 'local' | 'remote',
	sql: string,
	options: { persistTo?: string } = {},
): T[] {
	const out = execFileSync(
		'npx',
		[
			'wrangler',
			'-c',
			wranglerTomlPath(),
			'd1',
			'execute',
			'alkcloud',
			scope === 'remote' ? '--remote' : '--local',
			...(options.persistTo ? ['--persist-to', options.persistTo] : []),
			'--json',
			'--command',
			sql,
		],
		{ encoding: 'utf8', maxBuffer: 128 * 1024 * 1024, stdio: ['ignore', 'pipe', 'pipe'] },
	);
	const parsed = JSON.parse(out) as Array<{ results?: T[] }>;
	return parsed.flatMap((item) => item.results ?? []);
}

/** Dựng B2Storage từ env (read-only cần key đọc). */
export function createStorageFromEnv(): ObjectStorage {
	const endpoint = process.env.ALKCLOUD_TEST_B2_ENDPOINT ?? process.env.B2_ENDPOINT ?? '';
	const region = process.env.ALKCLOUD_TEST_B2_REGION ?? process.env.B2_REGION ?? '';
	const bucket = process.env.ALKCLOUD_TEST_B2_BUCKET ?? process.env.B2_BUCKET ?? '';
	const accessKeyId = process.env.ALKCLOUD_TEST_B2_KEY_ID ?? process.env.B2_ACCESS_KEY_ID ?? '';
	const secretAccessKey = process.env.ALKCLOUD_TEST_B2_APP_KEY ?? process.env.B2_SECRET_ACCESS_KEY ?? '';
	const missing = [
		['ALKCLOUD_TEST_B2_ENDPOINT', endpoint],
		['ALKCLOUD_TEST_B2_REGION', region],
		['ALKCLOUD_TEST_B2_BUCKET', bucket],
		['ALKCLOUD_TEST_B2_KEY_ID', accessKeyId],
		['ALKCLOUD_TEST_B2_APP_KEY', secretAccessKey],
	].filter(([, value]) => !value);
	if (missing.length > 0) {
		throw new Error(
			`thiếu cấu hình B2: ${missing.map(([name]) => name).join(', ')} (xem docs/20 §B3)`,
		);
	}
	return new B2Storage({ endpoint, region, bucket, accessKeyId, secretAccessKey });
}

/** Liệt kê TOÀN BỘ object trong bucket (có phân trang). READ_ONLY. */
export async function listAllObjects(
	storage: ObjectStorage,
	prefix?: string,
): Promise<StorageObject[]> {
	const objects: StorageObject[] = [];
	let continuationToken: string | undefined;
	let pages = 0;
	do {
		const result: ListObjectsResult = await storage.listObjects({
			...(prefix ? { prefix } : {}),
			...(continuationToken ? { continuationToken } : {}),
			maxKeys: 1000,
		});
		objects.push(...result.objects);
		continuationToken = result.nextContinuationToken ?? undefined;
		pages += 1;
		if (pages > 10_000) throw new Error('quá nhiều trang listing — dừng để tránh vòng lặp vô hạn');
	} while (continuationToken);
	return objects;
}

/** Thu thập snapshot đầy đủ. READ_ONLY. */
export async function collectSnapshot(
	scope: 'local' | 'remote',
	storage: ObjectStorage,
	prefix?: string,
): Promise<IntegritySnapshot> {
	const files = queryD1<FileMetadata>(
		scope,
		`SELECT id, name, size, object_key AS objectKey, revision_id AS revisionId,
		        etag, checksum_sha256 AS checksumSha256, deleted_at AS deletedAt,
		        purge_after AS purgeAfter, folder_id AS folderId
		 FROM files`,
	);
	const uploadSessions = queryD1<UploadSessionMetadata>(
		scope,
		`SELECT id, file_name AS fileName, object_key AS objectKey, status,
		        total_size AS totalSize, expires_at AS expiresAt, file_id AS fileId
		 FROM upload_sessions`,
	);
	const shares = queryD1<ShareMetadata>(
		scope,
		`SELECT id, file_id AS fileId, revoked_at AS revokedAt, expires_at AS expiresAt
		 FROM shares`,
	);
	const objects = await listAllObjects(storage, prefix);
	return { files, uploadSessions, shares, objects };
}
