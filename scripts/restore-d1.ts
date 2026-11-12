#!/usr/bin/env node
/**
 * Restore D1 của AlkCloud từ file SQL dump (tạo bởi scripts/backup-d1.ts).
 *
 *   node --import tsx scripts/restore-d1.ts --local  backups/alkcloud-d1-XXXX.sql [--fresh]
 *   node --import tsx scripts/restore-d1.ts --remote backups/alkcloud-d1-XXXX.sql --yes [--fresh]
 *
 * An toàn:
 * - `--remote` BẮT BUỘC kèm `--yes` (không restore production do nhầm lẫn).
 * - Không tự tạo database/bucket mới. Không xoá file backup.
 * - Dump của `d1 export` dùng `CREATE TABLE` (KHÔNG có IF NOT EXISTS) ⇒ restore vào
 *   DB đang có bảng sẽ lỗi. `--fresh` drop toàn bộ bảng trong dump trước khi nạp
 *   (chỉ dùng khi thực sự muốn thay thế dữ liệu).
 *
 * GUARD bắt buộc (M1 — không cho nhầm production):
 * - `--remote` BẮT BUỘC có `--yes` VÀ `--confirm <database_name>`.
 * - `database_id` trong wrangler.toml phải được cấu hình thật (không còn placeholder)
 *   và phải khớp `--confirm`.
 * - In ra database name + id (không phải secret) trước khi ghi.
 * - `--fresh` sẽ DROP bảng ⇒ luôn backup trước khi chạy.
 */

import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync, statSync } from 'node:fs';
import { resolve } from 'node:path';

const argv = process.argv.slice(2);
const flags = new Set(argv.filter((arg) => arg.startsWith('--')));
const fileArg = argv.find((arg) => !arg.startsWith('--'));

const remote = flags.has('--remote');
const local = flags.has('--local') || !remote;
const confirmed = flags.has('--yes');
const fresh = flags.has('--fresh');
const confirmIndex = argv.indexOf('--confirm');
const confirmName = confirmIndex >= 0 ? argv[confirmIndex + 1] : undefined;

/** Đọc database_name + database_id từ wrangler.toml (không phải secret). */
function readDatabaseTarget(): { name: string; id: string } | null {
	const configPath = resolve('apps/api/wrangler.toml');
	if (!existsSync(configPath)) return null;
	const content = readFileSync(configPath, 'utf8');
	const name = /^database_name\s*=\s*"([^"]+)"/m.exec(content)?.[1];
	const id = /^database_id\s*=\s*"([^"]+)"/m.exec(content)?.[1];
	if (!name || !id) return null;
	return { name, id };
}

function run(command: string): void {
	execFileSync(
		'npx',
		['wrangler', '-c', 'apps/api/wrangler.toml', 'd1', 'execute', 'alkcloud', remote ? '--remote' : '--local', '--command', command],
		{ stdio: 'inherit' },
	);
}

if (!fileArg) {
	console.error('Thiếu đường dẫn file dump. Ví dụ: --local backups/alkcloud-d1-20260101.sql');
	process.exit(1);
}
if (remote && !confirmed) {
	console.error('Từ chối restore REMOTE khi chưa có --yes (thao tác phá huỷ dữ liệu production).');
	process.exit(1);
}

const target = readDatabaseTarget();
if (!target) {
	console.error('Không đọc được database_name/database_id từ apps/api/wrangler.toml — từ chối chạy.');
	process.exit(1);
}
if (remote) {
	if (/^REPLACE_WITH|^$/.test(target.id)) {
		console.error(
			`Từ chối restore REMOTE: database_id "${target.id}" chưa được cấu hình thật (cần 'wrangler d1 create').`,
		);
		process.exit(1);
	}
	if (!confirmName || confirmName !== target.name) {
		console.error(
			`Từ chối restore REMOTE: thiếu hoặc sai --confirm. Bắt buộc: --confirm ${target.name}`,
		);
		process.exit(1);
	}
}
if (remote && local && flags.has('--local')) {
	console.error('Chọn một trong --local hoặc --remote.');
	process.exit(1);
}

const file = resolve(fileArg);
if (!existsSync(file)) {
	console.error(`Không thấy file: ${file}`);
	process.exit(1);
}
const sql = execFileSync('cat', [file], { encoding: 'utf8', maxBuffer: 256 * 1024 * 1024 });
if (!/CREATE TABLE/i.test(sql)) {
	console.error('File không giống SQL dump (thiếu CREATE TABLE). Từ chối restore.');
	process.exit(1);
}

console.log(`Restore D1 (${remote ? 'REMOTE' : 'LOCAL'}) từ ${file} (${(statSync(file).size / 1024 / 1024).toFixed(2)} MB)`);
console.log(`  database_name : ${target.name}`);
console.log(`  database_id   : ${target.id}`);
if (fresh) console.log('  CHẾ ĐỘ --fresh: sẽ DROP toàn bộ bảng trong dump trước khi nạp.');

try {
	if (fresh) {
		const tables = [...sql.matchAll(/CREATE TABLE (?:IF NOT EXISTS )?["`]?([\w]+)["`]?/g)].map((match) => match[1]);
		if (tables.length === 0) {
			console.error('Không tìm thấy bảng nào trong dump — từ chối --fresh.');
			process.exit(1);
		}
		console.log(`--fresh: drop ${tables.length} bảng (${tables.join(', ')})`);
		run(`PRAGMA foreign_keys=OFF; ${tables.map((name) => `DROP TABLE IF EXISTS "${name}";`).join(' ')}`);
	}
	execFileSync(
		'npx',
		['wrangler', '-c', 'apps/api/wrangler.toml', 'd1', 'execute', 'alkcloud', remote ? '--remote' : '--local', '--file', file, '--yes'],
		{ stdio: 'inherit' },
	);
	console.log('Restore xong. Kiểm tra số bản ghi: npx wrangler -c apps/api/wrangler.toml d1 execute alkcloud --local --command "SELECT COUNT(*) FROM owner"');
} catch (error) {
	console.error('Restore thất bại:', error instanceof Error ? error.message : error);
	process.exit(1);
}
