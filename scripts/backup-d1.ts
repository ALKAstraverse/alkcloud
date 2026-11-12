#!/usr/bin/env node
/**
 * Backup D1 của AlkCloud — export SQL ra file, sau đó (tuỳ chọn) upload lên TeraBox.
 *
 *   node --import tsx scripts/backup-d1.ts                  # chỉ export ra ./backups
 *   node --import tsx scripts/backup-d1.ts --upload         # export + rclone lên terabox
 *
 * KHÔNG chứa secret. Không tự ý xoá bản backup cũ.
 */

import { execFileSync } from 'node:child_process';
import { mkdirSync, readdirSync, statSync } from 'node:fs';
import { join, resolve } from 'node:path';

const args = new Set(process.argv.slice(2));
const upload = args.has('--upload');
const outDir = resolve('backups');

function timestamp(): string {
	return new Date().toISOString().replace(/[-:]/g, '').replace(/\..+$/, '');
}

function main(): void {
	mkdirSync(outDir, { recursive: true });
	const file = join(outDir, `alkcloud-d1-${timestamp()}.sql`);

	console.log(`Export D1 (local) -> ${file}`);
	try {
		// `d1 export` là lệnh chuẩn (`.dump` KHÔNG phải SQL nên `d1 execute` báo lỗi).
		execFileSync(
			'npx',
			[
				'wrangler',
				'-c',
				'apps/api/wrangler.toml',
				'd1',
				'export',
				'alkcloud',
				'--local',
				'--output',
				file,
				'--skip-confirmation',
			],
			{ encoding: 'utf8', maxBuffer: 64 * 1024 * 1024, stdio: 'pipe' },
		);
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

main();
