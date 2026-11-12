#!/usr/bin/env node
/**
 * AlkCloud — kiểm tra tính toàn vẹn file backup D1 (READ_ONLY).
 *
 *   node --import tsx scripts/verify-backup.ts backups/alkcloud-d1-XXXX.sql
 *   node --import tsx scripts/verify-backup.ts <file> --compare-remote
 *
 * Kiểm tra:
 *   1. File tồn tại, không rỗng, là SQL dump hợp lệ (có CREATE TABLE).
 *   2. Có đủ bảng bắt buộc của schema hiện tại.
 *   3. Không có câu lệnh nguy hiểm ngoài ý muốn (DROP DATABASE, ATTACH, PRAGMA write...).
 *   4. Số dòng mỗi bảng — trích từ dump.
 *   5. (tuỳ chọn) Đối chiếu số dòng với D1 đang chạy (local hoặc remote).
 *
 * READ_ONLY: chỉ đọc file + query D1. Không restore, không ghi.
 * Exit code: 0 = hợp lệ · 1 = không hợp lệ · 2 = lỗi tool.
 */

import { existsSync, readFileSync, statSync } from 'node:fs';
import { resolve } from 'node:path';
import { queryD1 } from './lib/snapshot.js';
import {
	countInsertStatements,
	countRows,
	DANGEROUS_PATTERNS,
	listTables,
} from '../packages/db/src/sql-dump.js';

const argv = process.argv.slice(2);
const fileArg = argv.find((arg) => !arg.startsWith('--'));
const compareRemote = argv.includes('--compare-remote');
const compareLocal = argv.includes('--compare-local');

/** Bảng bắt buộc theo schema hiện tại (migrations 0001–0003). */
const REQUIRED_TABLES = [
	'owner',
	'sessions',
	'recovery_codes',
	'folders',
	'files',
	'shares',
	'upload_sessions',
	'audit_logs',
	'audit_chain',
	'settings',
	'system_state',
	'idempotency_keys',
	'usage_daily',
	'quota_reservations',
];

function main(): void {
	if (!fileArg) {
		console.error('Thiếu file backup. Ví dụ: node --import tsx scripts/verify-backup.ts backups/alkcloud-d1-20260101.sql');
		process.exit(2);
	}
	const file = resolve(fileArg);
	console.log('== AlkCloud — verify backup (READ_ONLY) ==');
	console.log(`  file: ${file}`);

	if (!existsSync(file)) {
		console.error('✗ Không tìm thấy file.');
		process.exit(2);
	}
	const size = statSync(file).size;
	console.log(`  size: ${(size / 1024 / 1024).toFixed(2)} MiB`);
	if (size === 0) {
		console.error('✗ File rỗng — backup không hợp lệ.');
		process.exit(1);
	}

	const sql = readFileSync(file, 'utf8');
	const problems: string[] = [];

	// 1. Có phải SQL dump không
	if (!/CREATE TABLE/i.test(sql)) {
		problems.push('thiếu CREATE TABLE — không phải SQL dump');
	}

	// 2. Bảng bắt buộc
	const tableSet = new Set(listTables(sql));
	const missingTables = REQUIRED_TABLES.filter((table) => !tableSet.has(table));
	if (missingTables.length > 0) {
		problems.push(`thiếu bảng: ${missingTables.join(', ')}`);
	}

	// 3. Câu lệnh nguy hiểm
	for (const { pattern, reason } of DANGEROUS_PATTERNS) {
		if (pattern.test(sql)) problems.push(`chứa ${reason}`);
	}

	// 4. Số dòng
	const counts = countRows(sql);
	const rough = countInsertStatements(sql);
	console.log('');
	console.log('  Số dòng trong dump:');
	for (const table of [...tableSet].sort()) {
		const accurate = counts.get(table) ?? 0;
		const roughCount = rough.get(table) ?? 0;
		const marker = accurate === roughCount ? '' : ` (~${roughCount} lệnh INSERT)`;
		console.log(`    ${table.padEnd(22)} ${accurate}${marker}`);
	}

	// 5. Đối chiếu với DB đang chạy
	if (compareRemote || compareLocal) {
		const scope = compareRemote ? 'remote' : 'local';
		console.log('');
		console.log(`  Đối chiếu với D1 ${scope.toUpperCase()}:`);
		try {
			for (const table of [...tableSet].sort()) {
				const rows = queryD1<Record<string, number>>(scope, `SELECT COUNT(*) AS n FROM "${table}"`);
				const live = Number(rows[0]?.n ?? 0);
				const dumped = counts.get(table) ?? 0;
				const diff = live - dumped;
				const marker = diff === 0 ? '=' : diff > 0 ? `+${diff}` : `${diff}`;
				console.log(`    ${table.padEnd(22)} live=${String(live).padStart(6)} dump=${String(dumped).padStart(6)}  ${marker}`);
				if (diff > 0) {
					problems.push(`bảng "${table}": backup thiếu ${diff} dòng so với DB ${scope}`);
				}
			}
		} catch (error) {
			console.log(`    ! không đối chiếu được: ${error instanceof Error ? error.message : error}`);
		}
	}

	console.log('');
	if (problems.length === 0) {
		console.log('✓ Backup hợp lệ.');
		process.exit(0);
	}
	console.error('✗ Backup KHÔNG hợp lệ:');
	for (const problem of problems) console.error(`   - ${problem}`);
	process.exit(1);
}

main();
