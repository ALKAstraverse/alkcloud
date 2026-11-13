#!/usr/bin/env node
/**
 * Backup D1 của AlkCloud — export SQL ra file, sau đó (tuỳ chọn) upload lên TeraBox.
 *
 *   node --import tsx scripts/backup-d1.ts                  # export D1 LOCAL ra ./backups
 *   node --import tsx scripts/backup-d1.ts --remote         # export D1 PRODUCTION
 *   node --import tsx scripts/backup-d1.ts --upload         # export + rclone lên terabox
 *   node --import tsx scripts/backup-d1.ts --remote --upload # production + upload
 *
 * KHÔNG chứa secret. Không tự ý xoá bản backup cũ.
 *
 * LƯU Ý (bug đã sửa 13/11/2026): trước đây script **luôn** export `--local`,
 * bỏ qua cờ `--remote` ⇒ `npm run backup:d1 -- --remote` (quy trình trong
 * docs/21 §2.1) backup **database local** chứ không phải production ⇒ file
 * backup không phản ánh dữ liệu thật. Nay `--remote` được thực sự áp dụng
 * và scope được in rõ ra stdout.
 */

import { execFileSync } from 'node:child_process';
import { mkdirSync, readdirSync, statSync } from 'node:fs';
import { join, resolve } from 'node:path';

export interface BackupOptions {
	/** `--remote` ⇒ export D1 production. Mặc định FALSE (local) cho an toàn. */
	remote: boolean;
	upload: boolean;
}

/** Parse argv — thuần tuý, để test được. */
export function parseBackupArgs(argv: string[]): BackupOptions {
	const args = new Set(argv);
	return { remote: args.has('--remote'), upload: args.has('--upload') };
}

/**
 * Tham số cho `wrangler d1 export`.
 *
 * BẮT BUỘC: chỉ có đúng MỘT scope (`--local` HOẶC `--remote`) — nếu truyền cả
 * hai, wrangler có thể ưu tiên sai ⇒ backup lấy từ database khác với dự kiến.
 */
export function buildExportArgs(file: string, remote: boolean): string[] {
	return [
		'wrangler',
		'-c',
		'apps/api/wrangler.toml',
		'd1',
		'export',
		'alkcloud',
		remote ? '--remote' : '--local',
		'--output',
		file,
		'--skip-confirmation',
	];
}

const options = parseBackupArgs(process.argv.slice(2));
const upload = options.upload;
const outDir = resolve('backups');

function timestamp(): string {
	return new Date().toISOString().replace(/[-:]/g, '').replace(/\..+$/, '');
}

function main(): void {
	mkdirSync(outDir, { recursive: true });
	const file = join(outDir, `alkcloud-d1-${timestamp()}.sql`);

	const scope = options.remote ? 'production (--remote)' : 'local (--local)';
	console.log(`Export D1 ${scope} -> ${file}`);
	try {
		// `d1 export` là lệnh chuẩn (`.dump` KHÔNG phải SQL nên `d1 execute` báo lỗi).
		execFileSync('npx', buildExportArgs(file, options.remote), {
			encoding: 'utf8',
			maxBuffer: 64 * 1024 * 1024,
			stdio: 'pipe',
		});
		if (!statSync(file).size) {
			console.error('File dump rỗng — kiểm tra lại database binding.');
			process.exitCode = 1;
			return;
		}
	} catch (error) {
		console.error('Export thất bại:', error instanceof Error ? error.message : error);
		process.exitCode = 1;
		return;
	}

	const size = statSync(file).size;
	console.log(`  ${(size / 1024 / 1024).toFixed(2)} MB`);

	if (upload) {
		console.log('Upload lên terabox:backup/alkcloud ...');
		try {
			execFileSync('rclone', ['copyto', file, 'terabox:/backup/alkcloud/' + file.split('/').pop()], {
				stdio: 'inherit',
			});
			console.log('  xong');
		} catch (error) {
			console.error('Upload thất bại (file local vẫn còn):', error instanceof Error ? error.message : error);
			process.exitCode = 1;
			return;
		}
	}

	const files = readdirSync(outDir).filter((name) => name.endsWith('.sql'));
	console.log(`\nTổng ${files.length} file backup trong ${outDir}`);
}

// Chạy main() chỉ khi file được thực thi trực tiếp (không phải khi test import).
if (import.meta.url === `file://${process.argv[1]}`) main();
