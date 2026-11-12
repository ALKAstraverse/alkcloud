#!/usr/bin/env node
/**
 * AlkCloud — audit tính nhất quán storage (READ_ONLY).
 *
 *   node --import tsx scripts/audit-storage.ts [--local|--remote] [--prefix <p>] [--json <file>]
 *
 * Đối chiếu:
 *   - D1 metadata (files, upload_sessions, shares) ⇄ B2 objects
 *   - Object mồ côi (B2 có, D1 không)
 *   - Object thiếu (D1 có, B2 không) — CRITICAL
 *   - Lệch size / ETag / revision
 *   - Upload session hết hạn, share mồ côi
 *   - File trong trash thiếu purge_after
 *
 * An toàn:
 *   - READ_ONLY. Không ghi, không xoá, không sửa bất kỳ dữ liệu nào.
 *   - Không in secret (chỉ tên bucket + database).
 *   - File trong trash (retention 30 ngày) luôn được đánh dấu `protected`.
 *
 * Exit code: 0 = sạch (chỉ info/low) · 1 = có medium · 2 = có high/critical · 3 = lỗi tool.
 */

import { writeFileSync } from 'node:fs';
import { diffStorage, exitCodeFor, overallSeverity } from '../packages/storage/src/integrity.js';
import {
	collectSnapshot,
	createStorageFromEnv,
	queryD1,
	readTarget,
} from './lib/snapshot.js';
import type {
	FileMetadata,
	IntegritySnapshot,
	ShareMetadata,
	UploadSessionMetadata,
} from '../packages/storage/src/integrity.js';

const argv = process.argv.slice(2);
const scope = argv.includes('--remote') ? 'remote' : 'local';
const prefixIndex = argv.indexOf('--prefix');
const prefix = prefixIndex >= 0 ? argv[prefixIndex + 1] : undefined;
const jsonIndex = argv.indexOf('--json');
const jsonOut = jsonIndex >= 0 ? argv[jsonIndex + 1] : undefined;
/** Chỉ audit phần metadata D1 (bỏ qua B2) — dùng khi chưa cấu hình B2 (B3). */
const metadataOnly = argv.includes('--metadata-only');

async function main(): Promise<void> {
	console.log('== AlkCloud — audit storage (READ_ONLY) ==');
	const target = readTarget(scope);
	console.log(`  scope        : ${scope.toUpperCase()}`);
	console.log(`  database     : ${target.databaseName} (${target.databaseId})`);
	console.log(`  bucket       : ${target.bucket || '(chưa cấu hình)'}`);
	console.log(`  prefix       : ${prefix ?? '(toàn bộ)'}`);
	console.log(`  chế độ       : ${metadataOnly ? 'METADATA-ONLY (không kiểm tra B2)' : 'ĐẦY ĐỦ'}`);

	let snapshot: IntegritySnapshot;
	let storageChecked = true;
	if (metadataOnly) {
		storageChecked = false;
		snapshot = {
			files: queryD1<FileMetadata>(
				scope,
				`SELECT id, name, size, object_key AS objectKey, revision_id AS revisionId,
				        etag, checksum_sha256 AS checksumSha256, deleted_at AS deletedAt,
				        purge_after AS purgeAfter, folder_id AS folderId
				 FROM files`,
			),
			uploadSessions: queryD1<UploadSessionMetadata>(
				scope,
				`SELECT id, file_name AS fileName, object_key AS objectKey, status,
				        total_size AS totalSize, expires_at AS expiresAt, file_id AS fileId
				 FROM upload_sessions`,
			),
			shares: queryD1<ShareMetadata>(
				scope,
				`SELECT id, file_id AS fileId, revoked_at AS revokedAt, expires_at AS expiresAt
				 FROM shares`,
			),
			objects: [],
			storageChecked: false,
		};
	} else {
		const storage = createStorageFromEnv();
		snapshot = await collectSnapshot(scope, storage, prefix);
	}
	console.log(
		`  snapshot     : ${snapshot.files.length} file · ${snapshot.uploadSessions.length} session · ` +
			`${snapshot.shares.length} share · ${snapshot.objects.length} object`,
	);

	const report = diffStorage(snapshot, new Date().toISOString());

	console.log('');
	if (report.findings.length === 0) {
		console.log('✓ Không phát hiện sai lệch nào.');
	} else {
		const bySeverity = { critical: 0, high: 0, medium: 0, low: 0, info: 0 };
		for (const finding of report.findings) bySeverity[finding.severity] += 1;
		console.log(
			`Phát hiện: critical=${bySeverity.critical} high=${bySeverity.high} medium=${bySeverity.medium} ` +
				`low=${bySeverity.low} info=${bySeverity.info}`,
		);
		for (const finding of report.findings) {
			const icon = finding.severity === 'critical' || finding.severity === 'high' ? '✗' : '!';
			const shield = finding.protected ? ' [ĐƯỢC BẢO VỆ]' : '';
			console.log(`  ${icon} [${finding.severity}] ${finding.kind} — ${finding.subject}${shield}`);
			console.log(`      ${finding.detail}`);
			console.log(`      → ${finding.suggestion}`);
		}
	}

	console.log('');
	console.log(
		`Bytes: metadata=${formatBytes(report.bytes.expectedFromMetadata)} ` +
			`storage=${formatBytes(report.bytes.actualInStorage)} ` +
			`chênh lệch=${report.bytes.delta >= 0 ? '+' : ''}${formatBytes(report.bytes.delta)}`,
	);
	console.log(`Mức tổng thể: ${overallSeverity(report).toUpperCase()}`);

	if (!storageChecked) {
		console.log('');
		console.log(
			'⚠ CHẾ ĐỘ METADATA-ONLY: phần B2 (object thiếu/mồ côi, lệch size/ETag) CHƯA được kiểm tra.',
		);
		console.log('  ⇒ KHÔNG được coi là "storage đã xác minh". Cần B2 key (docs/20 §B3) để audit đầy đủ.');
	}

	const payload = {
		...report,
		target: {
			scope,
			databaseName: target.databaseName,
			databaseId: target.databaseId,
			bucket: target.bucket,
			prefix: prefix ?? null,
			storageChecked,
		},
	};
	const json = `${JSON.stringify(payload, null, 2)}\n`;
	if (jsonOut) {
		writeFileSync(jsonOut, json);
		console.log(`\nBáo cáo JSON: ${jsonOut}`);
	} else {
		console.log('');
		console.log(json);
	}
	// Không kiểm tra B2 ⇒ KHÔNG được báo PASS ⇒ exit 3 (SKIPPED).
	process.exitCode = storageChecked ? exitCodeFor(report) : 3;
}

function formatBytes(bytes: number): string {
	const units = ['B', 'KiB', 'MiB', 'GiB', 'TiB'];
	let value = Math.abs(bytes);
	let unit = 0;
	while (value >= 1024 && unit < units.length - 1) {
		value /= 1024;
		unit += 1;
	}
	return `${bytes < 0 ? '-' : ''}${value.toFixed(unit === 0 ? 0 : 2)} ${units[unit]}`;
}

main().catch((error: unknown) => {
	console.error('Audit thất bại:', error instanceof Error ? error.message : error);
	process.exit(3);
});
