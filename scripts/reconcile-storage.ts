#!/usr/bin/env node
/**
 * AlkCloud — reconcile storage: audit + KẾ HOẠCH khắc phục (mặc định READ_ONLY).
 *
 *   node --import tsx scripts/reconcile-storage.ts [--local|--remote] [--plan-only]
 *   node --import tsx scripts/reconcile-storage.ts --remote --apply --yes --confirm <bucket>
 *
 * Hành vi:
 *   - Mặc định (không `--apply`): chỉ in KẾ HOẠCH khắc phục, KHÔNG ghi bất kỳ thứ gì.
 *   - `--apply`: thực thi các hành động an toàn. Mặc định CHỈ xử lý nhóm
 *     `orphan_upload_session` (dọn session hết hạn + xoá object mồ côi tương ứng).
 *     Mọi hành động khác (xoá object mồ côi tự do, sửa metadata) cần `--allow-destructive`
 *     và vẫn KHÔNG chạy nếu chưa có `--yes` + `--confirm <bucket>`.
 *
 * GUARD bắt buộc cho `--apply`:
 *   - `--yes` (xác nhận đã đọc kế hoạch)
 *   - `--confirm <bucket>` phải khớp ĐÚNG bucket trong cấu hình
 *   - `--remote` bắt buộc có `database_id` thật (không placeholder)
 *   - KHÔNG bao giờ xoá object còn được tham chiếu (metadata/trash/share/session)
 *   - KHÔNG bao giờ đụng file đang trong trash retention (30 ngày)
 *
 * Exit code: 0 = không có việc cần làm · 1 = có phát hiện chưa xử lý · 2 = lỗi tool.
 */

import { B2Storage, type ObjectStorage } from '../packages/storage/src/index.js';
import {
	diffStorage,
	parseObjectKey,
	type FileMetadata,
	type IntegrityFinding,
	type IntegrityReport,
	type UploadSessionMetadata,
} from '../packages/storage/src/integrity.js';
import { collectSnapshot, createStorageFromEnv, readTarget } from './lib/snapshot.js';

interface TableCount {
	table: string;
	source: number;
	target: number;
}

const argv = process.argv.slice(2);
const scope = argv.includes('--remote') ? 'remote' : 'local';
const apply = argv.includes('--apply');
const planOnly = argv.includes('--plan-only') || !apply;
const confirmed = argv.includes('--yes');
const allowDestructive = argv.includes('--allow-destructive');
const confirmIndex = argv.indexOf('--confirm');
const confirmBucket = confirmIndex >= 0 ? argv[confirmIndex + 1] : undefined;

/** Hành động đề xuất cho từng nhóm phát hiện. */
interface Action {
	finding: IntegrityFinding;
	action: 'reap-expired-session' | 'delete-orphan-object' | 'manual';
	reason: string;
}

function classify(findings: IntegrityFinding[]): Action[] {
	return findings.map((finding) => {
		switch (finding.kind) {
			case 'stale_upload_session':
				return {
					finding,
					action: 'reap-expired-session',
					reason: 'Session upload hết hạn nhưng còn OPEN ⇒ giữ quota reserved và object mồ côi.',
				};
			case 'orphan_object':
				return {
					finding,
					action: 'delete-orphan-object',
					reason: 'Object trên B2 không còn metadata nào tham chiếu.',
				};
			default:
				return { finding, action: 'manual', reason: 'Cần quyết định của owner.' };
		}
	});
}

async function main(): Promise<void> {
	console.log('== AlkCloud — reconcile storage ==');
	const target = readTarget(scope);
	console.log(`  scope   : ${scope.toUpperCase()}`);
	console.log(`  database: ${target.databaseName} (${target.databaseId})`);
	console.log(`  bucket  : ${target.bucket || '(chưa cấu hình)'}`);
	console.log(`  chế độ  : ${planOnly ? 'PLAN-ONLY (READ_ONLY)' : 'APPLY'}`);

	const storage = createStorageFromEnv();
	const snapshot = await collectSnapshot(scope, storage);
	const report = diffStorage(snapshot, new Date().toISOString());
	const actions = classify(report.findings);

	if (actions.length === 0) {
		console.log('\n✓ Không có sai lệch — không cần hành động nào.');
		process.exitCode = 0;
		return;
	}

	console.log(`\nKế hoạch (${actions.length} hành động):`);
	let index = 0;
	for (const action of actions) {
		index += 1;
		const tag =
			action.action === 'manual'
				? 'MANUAL'
				: action.action === 'reap-expired-session'
					? 'REAP'
					: 'DELETE';
		console.log(`  ${index}. [${tag}] ${action.finding.kind} — ${action.finding.subject}`);
		console.log(`     ${action.finding.detail}`);
		console.log(`     lý do: ${action.reason}`);
	}

	if (planOnly) {
		console.log('\n— PLAN-ONLY: không có thay đổi nào được thực hiện. —');
		console.log('Để thực thi: thêm --apply --yes --confirm <bucket>');
		process.exitCode = 1;
		return;
	}

	// ------------------------------------------------------------ guard
	if (!confirmed) {
		console.error('\nTừ chối apply: thiếu --yes (phải xác nhận đã đọc kế hoạch).');
		process.exit(2);
	}
	if (!confirmBucket || confirmBucket !== target.bucket) {
		console.error(
			`\nTừ chối apply: --confirm phải khớp CHÍNH XÁC bucket "${target.bucket}" ` +
				`(nhận "${confirmBucket ?? '(thiếu)'}").`,
		);
		process.exit(2);
	}

	const destructive = actions.filter((action) => action.action === 'delete-orphan-object');
	if (destructive.length > 0 && !allowDestructive) {
		console.error(
			`\nTừ chối apply: có ${destructive.length} hành động XOÁ object. ` +
				'Cần thêm --allow-destructive sau khi đã xác minh từng object trong kế hoạch.',
		);
		process.exit(2);
	}

	// ------------------------------------------------------------ thực thi
	const protectedKeys = new Set<string>();
	for (const file of snapshot.files) protectedKeys.add(file.objectKey);
	for (const session of snapshot.uploadSessions) protectedKeys.add(session.objectKey);

	const now = new Date().toISOString();
	let reaped = 0;
	let deleted = 0;
	let skipped = 0;

	for (const action of actions) {
		if (action.action === 'manual') {
			skipped += 1;
			continue;
		}
		if (action.action === 'reap-expired-session') {
			const session = snapshot.uploadSessions.find((item) => item.id === action.finding.subject);
			if (!session) {
				skipped += 1;
				continue;
			}
			await reapExpiredSession(storage, session, now);
			reaped += 1;
			console.log(`  ✓ reap session ${session.id}`);
			continue;
		}
		if (action.action === 'delete-orphan-object') {
			const key = action.finding.subject;
			if (protectedKeys.has(key)) {
				console.log(`  ! bỏ qua ${key} — đang được tham chiếu (an toàn)`);
				skipped += 1;
				continue;
			}
			await storage.deleteObject(key);
			deleted += 1;
			console.log(`  ✓ xoá object mồ côi ${key}`);
		}
	}

	console.log(`\nKết quả: reap=${reaped} delete=${deleted} skipped=${skipped}`);
	console.log('Chạy lại `audit-storage.ts` để xác nhận.');
	process.exitCode = 0;
}

/**
 * Dọn upload session hết hạn: xoá object tương ứng (nếu có) + đánh dấu EXPIRED.
 * Object được xoá TRƯỚC khi cập nhật D1 để không để lại metadata trỏ tới object đã mất.
 */
async function reapExpiredSession(
	storage: ObjectStorage,
	session: UploadSessionMetadata,
	now: string,
): Promise<void> {
	const parsed = parseObjectKey(session.objectKey);
	if (parsed) {
		try {
			const versions = await storage.listObjectVersions(session.objectKey);
			for (const version of versions) {
				await storage.deleteObjectVersion(session.objectKey, version.versionId);
			}
			if (versions.length === 0) await storage.deleteObject(session.objectKey);
		} catch {
			// Không xoá được object ⇒ GIỮ session để cron thử lại lần sau (không mất dữ liệu).
			throw new Error(`không xoá được object của session ${session.id} — giữ session để thử lại`);
		}
	}
	await markSessionExpired(session.id, now);
}

/** Cập nhật D1 đánh dấu session EXPIRED + giải phóng quota. */
async function markSessionExpired(sessionId: string, now: string): Promise<void> {
	const { execFileSync } = await import('node:child_process');
	const scopeFlag = scope === 'remote' ? '--remote' : '--local';
	execFileSync(
		'npx',
		[
			'wrangler',
			'-c',
			'apps/api/wrangler.toml',
			'd1',
			'execute',
			'alkcloud',
			scopeFlag,
			'--command',
			`UPDATE upload_sessions SET status='EXPIRED', updated_at='${now}' WHERE id='${sessionId}' AND status='OPEN';`,
		],
		{ stdio: 'pipe' },
	);
	execFileSync(
		'npx',
		[
			'wrangler',
			'-c',
			'apps/api/wrangler.toml',
			'd1',
			'execute',
			'alkcloud',
			scopeFlag,
			'--command',
			`UPDATE quota_reservations SET state='RELEASED', released_at='${now}' WHERE upload_session_id='${sessionId}' AND state='HELD';`,
		],
		{ stdio: 'pipe' },
	);
}

main().catch((error: unknown) => {
	console.error('Reconcile thất bại:', error instanceof Error ? error.message : error);
	process.exit(2);
});
