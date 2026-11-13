#!/usr/bin/env node
/**
 * AlkCloud — restore drill (tự động, chỉ trên local).
 *
 *   node --import tsx scripts/restore-drill.ts
 *
 * Quy trình:
 *   1. Export D1 local hiện tại → file tạm trong backups/.
 *   2. Xác minh file backup (dùng verify-backup logic).
 *   3. Tạo D1 "đích" RIÊNG (state dir tạm) — KHÔNG chạm D1 local chính.
 *   4. Restore dump vào D1 đích.
 *   5. Đối chiếu số dòng từng bảng giữa nguồn và đích.
 *   6. Kiểm tra tính toàn vẹn tham chiếu: file→folder, share→file, session→folder.
 *   7. Báo cáo JSON + Markdown.
 *
 * An toàn:
 *   - LOCAL_WRITE duy nhất: ghi vào thư mục state tạm + backups/.
 *   - KHÔNG bao giờ đụng `--remote`. Từ chối nếu truyền `--remote`.
 *   - D1 đích dùng `--persist-to <dir tạm>` riêng ⇒ không ghi đè state chính.
 *
 * Exit code: 0 = drill PASS · 1 = drill FAIL · 2 = lỗi tool.
 */

import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { queryD1 } from './lib/snapshot.js';
import { DrillArgsError, parseDrillArgs } from './lib/drill-args.js';
import { countRows, listTables, splitDump } from '../packages/db/src/sql-dump.js';

const argv = process.argv.slice(2);
let drillArgs: ReturnType<typeof parseDrillArgs>;
try {
	drillArgs = parseDrillArgs(argv);
} catch (error) {
	if (error instanceof DrillArgsError) {
		console.error(error.message);
		process.exit(2);
	}
	throw error;
}
const jsonOut = drillArgs.json;

interface StepResult {
	name: string;
	status: 'PASS' | 'FAIL';
	detail: string;
}

interface TableCount {
	table: string;
	source: number;
	target: number;
}

const steps: StepResult[] = [];
let tableCounts: TableCount[] = [];

function record(name: string, status: 'PASS' | 'FAIL', detail: string): void {
	steps.push({ name, status, detail });
	console.log(`${status === 'PASS' ? '✓' : '✗'} ${name} — ${detail}`);
}

function runWrangler(args: string[], options: { cwd?: string } = {}): string {
	return execFileSync('npx', args, {
		encoding: 'utf8',
		maxBuffer: 256 * 1024 * 1024,
		stdio: ['ignore', 'pipe', 'pipe'],
		...(options.cwd ? { cwd: options.cwd } : {}),
	});
}

function main(): void {
	console.log('== AlkCloud — restore drill (LOCAL_WRITE, không đụng production) ==');
	const tempRoot = mkdtempSync(join(tmpdir(), 'alkcloud-restore-drill-'));
	const targetState = join(tempRoot, 'state');
	const dumpFile = join(tempRoot, 'drill-dump.sql');

	try {
		// ---------------------------------------------------------- 1. lấy dump nguồn
		// `--file <dump>` ⇒ dùng dump có sẵn (ví dụ backup production tải về).
		// Không có `--file` ⇒ export D1 local như trước.
		let dump: string;
		let sourceLabel: string;
		if (drillArgs.file) {
			dump = readFileSync(resolve(drillArgs.file), 'utf8');
			sourceLabel = `file có sẵn: ${resolve(drillArgs.file)}`;
		} else {
			runWrangler([
				'wrangler',
				'-c',
				'apps/api/wrangler.toml',
				'd1',
				'export',
				'alkcloud',
				'--local',
				'--output',
				dumpFile,
				'--skip-confirmation',
			]);
			dump = readFileSync(dumpFile, 'utf8');
			sourceLabel = 'D1 local (wrangler --local)';
		}
		if (!/CREATE TABLE/i.test(dump)) {
			record('lấy dump nguồn', 'FAIL', 'dump không có CREATE TABLE');
			process.exit(1);
		}
		record('lấy dump nguồn', 'PASS', `${(dump.length / 1024).toFixed(1)} KiB SQL — ${sourceLabel}`);

		// ---------------------------------------------------------- 2. đối chiếu số dòng nguồn
		const sourceCounts = countRows(dump);
		const tables = [...sourceCounts.keys()].sort();
		if (tables.length === 0) {
			record('dump có bảng', 'FAIL', 'dump không có bảng nào');
			process.exit(1);
		}
		record('dump có bảng', 'PASS', `${tables.length} bảng: ${tables.join(', ')}`);

		// ---------------------------------------------------------- 3. restore vào D1 đích
		// Dùng `--persist-to` để tách state hoàn toàn khỏi D1 local chính.
		// Restore 2 pha (schema → data): dump của `d1 export` có thể tạo bảng con
		// (FK) trước bảng cha; nạp 1 pha sẽ lỗi "no such table: main.<cha>".
		const { schema, data } = splitDump(dump);
		const schemaFile = join(tempRoot, 'schema.sql');
		const dataFile = join(tempRoot, 'data.sql');
		writeFileSync(schemaFile, schema, 'utf8');
		writeFileSync(dataFile, data, 'utf8');
		runWrangler([
			'wrangler',
			'-c',
			'apps/api/wrangler.toml',
			'd1',
			'execute',
			'alkcloud',
			'--local',
			'--persist-to',
			targetState,
			'--file',
			schemaFile,
			'--yes',
		]);
		runWrangler([
			'wrangler',
			'-c',
			'apps/api/wrangler.toml',
			'd1',
			'execute',
			'alkcloud',
			'--local',
			'--persist-to',
			targetState,
			'--file',
			dataFile,
			'--yes',
		]);
		record('restore vào D1 đích', 'PASS', `state tạm: ${targetState}`);

		// ---------------------------------------------------------- 4. đối chiếu số dòng
		let mismatches = 0;
		for (const table of tables) {
			const rows = queryD1<Record<string, number>>(
				'local',
				`SELECT COUNT(*) AS n FROM "${table}"`,
				{ persistTo: targetState },
			);
			const target = Number(rows[0]?.n ?? 0);
			const source = sourceCounts.get(table) ?? 0;
			tableCounts.push({ table, source, target });
			if (source !== target) mismatches += 1;
		}
		if (mismatches > 0) {
			record(
				'đối chiếu số dòng',
				'FAIL',
				`${mismatches}/${tables.length} bảng lệch: ${tableCounts
					.filter((item) => item.source !== item.target)
					.map((item) => `${item.table} (${item.source}→${item.target})`)
					.join(', ')}`,
			);
		} else {
			record('đối chiếu số dòng', 'PASS', `${tables.length}/${tables.length} bảng khớp`);
		}

		// ---------------------------------------------------------- 5. tính toàn vẹn tham chiếu
		const orphanFiles = Number(
			queryD1<Record<string, number>>(
				'local',
				`SELECT COUNT(*) AS n FROM files WHERE folder_id IS NOT NULL AND folder_id NOT IN (SELECT id FROM folders)`,
				{ persistTo: targetState },
			)[0]?.n ?? 0,
		);
		const orphanShares = Number(
			queryD1<Record<string, number>>(
				'local',
				`SELECT COUNT(*) AS n FROM shares WHERE file_id NOT IN (SELECT id FROM files)`,
				{ persistTo: targetState },
			)[0]?.n ?? 0,
		);
		const orphanSessions = Number(
			queryD1<Record<string, number>>(
				'local',
				`SELECT COUNT(*) AS n FROM upload_sessions WHERE folder_id IS NOT NULL AND folder_id NOT IN (SELECT id FROM folders)`,
				{ persistTo: targetState },
			)[0]?.n ?? 0,
		);
		const ownerCount = Number(
			queryD1<Record<string, number>>('local', 'SELECT COUNT(*) AS n FROM owner', {
				persistTo: targetState,
			})[0]?.n ?? 0,
		);
		if (ownerCount > 1) {
			record('owner singleton', 'FAIL', `${ownerCount} owner — vi phạm idx_owner_singleton`);
		} else {
			record('owner singleton', 'PASS', `${ownerCount} owner`);
		}
		const refProblems =
			orphanFiles + orphanShares + orphanSessions;
		if (refProblems > 0) {
			record(
				'tính toàn vẹn tham chiếu',
				'FAIL',
				`file mồ côi=${orphanFiles}, share mồ côi=${orphanShares}, session mồ côi=${orphanSessions}`,
			);
		} else {
			record('tính toàn vẹn tham chiếu', 'PASS', 'không có tham chiếu hỏng');
		}

		// ---------------------------------------------------------- 5b. FK check của D1 đích
		const fkViolations = queryD1<Record<string, unknown>>(
			'local',
			'PRAGMA foreign_key_check',
			{ persistTo: targetState },
		);
		if (fkViolations.length > 0) {
			record(
				'foreign_key_check (D1 đích)',
				'FAIL',
				`${fkViolations.length} vi phạm FK: ${JSON.stringify(fkViolations.slice(0, 5))}`,
			);
		} else {
			record('foreign_key_check (D1 đích)', 'PASS', 'không có vi phạm FK');
		}

		// ---------------------------------------------------------- 6. báo cáo
		const report = {
			generatedAt: new Date().toISOString(),
			drill: 'restore-d1-local',
			source: sourceLabel,
			target: 'D1 local isolate (--persist-to state tạm)',
			steps,
			tableCounts,
			passed: steps.every((step) => step.status === 'PASS'),
		};
		const json = `${JSON.stringify(report, null, 2)}\n`;
		const md = [
			'# AlkCloud — Restore drill report',
			'',
			`- Thời điểm: ${report.generatedAt}`,
			`- Nguồn: ${report.source}`,
			`- Đích: ${report.target}`,
			`- Kết quả: **${report.passed ? 'PASS' : 'FAIL'}**`,
			'',
			'| Bước | Trạng thái | Chi tiết |',
			'| :--- | :--- | :--- |',
			...steps.map((step) => `| ${step.name} | ${step.status} | ${step.detail.replace(/\|/g, '\\|')} |`),
			'',
			'| Bảng | Nguồn | Đích |',
			'| :--- | ---: | ---: |',
			...tableCounts.map((item) => `| ${item.table} | ${item.source} | ${item.target} |`),
			'',
		].join('\n');
		writeFileSync('restore-drill-report.json', json);
		writeFileSync('restore-drill-report.md', md);
		console.log('');
		console.log(`Báo cáo: restore-drill-report.json, restore-drill-report.md`);
		if (jsonOut) {
			writeFileSync(jsonOut, json);
			console.log(`Báo cáo JSON: ${jsonOut}`);
		}

		const failed = steps.some((step) => step.status === 'FAIL');
		console.log('');
		console.log(failed ? 'KẾT QUẢ: FAIL — restore drill không đạt.' : 'KẾT QUẢ: PASS — restore thành công và dữ liệu khớp.');
		process.exitCode = failed ? 1 : 0;
	} catch (error) {
		console.error('Restore drill lỗi:', error instanceof Error ? error.message : error);
		process.exitCode = 2;
	} finally {
		rmSync(tempRoot, { recursive: true, force: true });
	}
}

main();
