#!/usr/bin/env node
/**
 * Chạy migration D1 cho AlkCloud.
 *
 *   node --import tsx scripts/migrate.ts --local            # D1 local (file .wrangler/state)
 *   node --import tsx scripts/migrate.ts --remote           # D1 production (CẦN OWNER DUYỆT)
 *   node --import tsx scripts/migrate.ts --local --dry-run  # chỉ in kế hoạch
 *   node --import tsx scripts/migrate.ts --local --force    # chạy lại file đã áp dụng (KHÔNG khuyến nghị)
 *
 * An toàn:
 * - Ghi bảng `_migrations (version, name, checksum, applied_at)` ⇒ biết chính xác
 *   migration nào đã chạy, KHÔNG chạy trùng.
 * - Nếu file migration đã áp dụng mà nội dung thay đổi (checksum khác) ⇒ dừng,
 *   yêu cầu owner duyệt `--force`.
 * - Script chỉ đọc/ghi database được khai báo trong apps/api/wrangler.toml.
 *   KHÔNG tự tạo resource mới, KHÔNG tự deploy.
 */

import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { readdirSync, readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const MIGRATIONS_DIR = resolve(here, '../apps/api/migrations');
const WRANGLER_CONFIG = resolve(here, '../apps/api/wrangler.toml');

const args = new Set(process.argv.slice(2));
const remote = args.has('--remote');
const dryRun = args.has('--dry-run');
const force = args.has('--force');

export interface MigrationFile {
	name: string;
	version: string;
	content: string;
	checksum: string;
}

export function loadMigrationFiles(): MigrationFile[] {
	return readdirSync(MIGRATIONS_DIR)
		.filter((name) => name.endsWith('.sql'))
		.sort()
		.map((name) => {
			const content = readFileSync(join(MIGRATIONS_DIR, name), 'utf8');
			const match = /^(\d+)_(.+)\.sql$/.exec(name);
			return {
				name,
				version: match?.[1] ?? name.replace(/\.sql$/, ''),
				content,
				checksum: createHash('sha256').update(content).digest('hex').slice(0, 16),
			};
		});
}

function wrangler(argsList: string[]): string {
	return execFileSync('npx', ['wrangler', '-c', WRANGLER_CONFIG, ...argsList], {
		encoding: 'utf8',
		maxBuffer: 64 * 1024 * 1024,
	});
}

function queryJson(sql: string): Array<Record<string, unknown>> {
	try {
		const raw = wrangler([
			'd1',
			'execute',
			'alkcloud',
			remote ? '--remote' : '--local',
			'--json',
			'--command',
			sql,
		]);
		const parsed = JSON.parse(raw) as Array<{ results?: Array<Record<string, unknown>> }>;
		return parsed.flatMap((item) => item.results ?? []);
	} catch {
		return [];
	}
}

async function main(): Promise<void> {
	const files = loadMigrationFiles();
	console.log(
		`AlkCloud migrate — ${files.length} file, chế độ: ${remote ? 'REMOTE' : 'LOCAL'}${dryRun ? ' (dry-run)' : ''}`,
	);
	for (const file of files) console.log(`  - ${file.name} (version=${file.version}, checksum=${file.checksum})`);

	// Bảng theo dõi migration (tương thích với packages/db/src/migrate.ts).
	wrangler([
		'd1',
		'execute',
		'alkcloud',
		remote ? '--remote' : '--local',
		'--command',
		`CREATE TABLE IF NOT EXISTS _migrations (version TEXT PRIMARY KEY, name TEXT NOT NULL, checksum TEXT, applied_at TEXT NOT NULL);`,
	]);

	const appliedRows = queryJson('SELECT version, name, checksum FROM _migrations ORDER BY version');
	const applied = new Map<string, { name: string; checksum: string | null }>(
		appliedRows.map((row) => [
			String(row.version),
			{ name: String(row.name ?? ''), checksum: (row.checksum as string | null) ?? null },
		]),
	);

	const pending = files.filter((file) => !applied.has(file.version));
	const changed = files.filter((file) => {
		const record = applied.get(file.version);
		return record && record.checksum && record.checksum !== file.checksum;
	});

	if (changed.length > 0) {
		console.error('\n✗ DỪNG — file migration đã áp dụng nhưng nội dung đã thay đổi:');
		for (const file of changed) {
			console.error(
				`   ${file.name}: đang lưu checksum=${applied.get(file.version)?.checksum}, file hiện tại checksum=${file.checksum}`,
			);
		}
		console.error('   Nếu đây là chủ ý, hãy tạo file migration MỚI thay vì sửa file cũ.');
		console.error('   (--force chỉ dành cho owner xác nhận, KHÔNG dùng mặc định.)');
		process.exitCode = 1;
		return;
	}

	if (pending.length === 0) {
		console.log('\nKhông có migration nào cần chạy — database đã đúng version.');
		return;
	}
	console.log(`\nCần áp dụng: ${pending.map((file) => file.name).join(', ')}`);
	if (dryRun) {
		console.log('Dry-run: không thực thi.');
		return;
	}

	for (const file of pending) {
		console.log(`\n==> apply ${file.name}`);
		try {
			wrangler([
				'd1',
				'execute',
				'alkcloud',
				remote ? '--remote' : '--local',
				'--file',
				join(MIGRATIONS_DIR, file.name),
			]);
			wrangler([
				'd1',
				'execute',
				'alkcloud',
				remote ? '--remote' : '--local',
				'--command',
				`INSERT INTO _migrations (version, name, checksum, applied_at) VALUES ('${file.version}', '${file.name.replace(/'/g, "''")}', '${file.checksum}', datetime('now'));`,
			]);
		} catch (error) {
			console.error(`Không apply được ${file.name}:`);
			console.error(error instanceof Error ? error.message : error);
			console.error(
				'Migration KHÔNG được đánh dấu đã chạy — sửa nguyên nhân rồi chạy lại (script sẽ bỏ qua file đã áp dụng).',
			);
			process.exitCode = 1;
			return;
		}
	}
	console.log('\nHoàn tất. Kiểm tra: npx wrangler -c apps/api/wrangler.toml d1 execute alkcloud --local --command "SELECT version FROM _migrations"');
}

void main();
