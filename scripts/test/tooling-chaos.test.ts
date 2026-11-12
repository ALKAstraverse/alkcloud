import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { splitDump, countRows, listTables, DANGEROUS_PATTERNS } from '../../packages/db/src/sql-dump.js';

const ROOT = resolve(import.meta.dirname, '../..');

function runScript(script: string, args: string[] = []): { status: number; stdout: string; stderr: string } {
	try {
		const stdout = execFileSync('node', ['--import', 'tsx', script, ...args], {
			cwd: ROOT,
			encoding: 'utf8',
			stdio: ['ignore', 'pipe', 'pipe'],
			timeout: 120_000,
		});
		return { status: 0, stdout, stderr: '' };
	} catch (error) {
		const err = error as { status?: number; stdout?: string; stderr?: string };
		return {
			status: err.status ?? 1,
			stdout: err.stdout ?? '',
			stderr: err.stderr ?? '',
		};
	}
}

describe('chaos — tooling: backup/restore với dữ liệu hỏng', () => {
	it('T1. restore-d1.ts --remote bị từ chối khi thiếu --yes', () => {
		const result = runScript('scripts/restore-d1.ts', ['--remote', 'backups/x.sql']);
		assert.notEqual(result.status, 0);
		assert.match(result.stderr + result.stdout, /--yes/);
	});

	it('T2. restore-d1.ts --remote bị từ chối khi thiếu --confirm', () => {
		const result = runScript('scripts/restore-d1.ts', ['--remote', '--yes', 'backups/x.sql']);
		assert.notEqual(result.status, 0);
		// Guard có thể chặn ở bước "database_id còn placeholder" HOẶC "thiếu --confirm" —
		// cả hai đều là hành vi đúng (không bao giờ restore production do nhầm).
		assert.match(result.stderr + result.stdout, /--confirm|placeholder|REPLACE_WITH/);
	});

	it('T3. restore-drill.ts từ chối --remote (không bao giờ drill trên production)', () => {
		const result = runScript('scripts/restore-drill.ts', ['--remote']);
		assert.notEqual(result.status, 0);
		assert.match(result.stderr + result.stdout, /Từ chối/);
	});

	it('T4. seed-local-d1.ts từ chối --remote (không seed production)', () => {
		const result = runScript('scripts/seed-local-d1.ts', ['--remote']);
		assert.notEqual(result.status, 0);
		assert.match(result.stderr + result.stdout, /Từ chối/);
	});

	it('T5. audit-storage.ts --remote từ chối khi database_id còn placeholder', () => {
		const result = runScript('scripts/audit-storage.ts', ['--remote']);
		assert.notEqual(result.status, 0);
		assert.match(result.stderr + result.stdout, /placeholder|REPLACE_WITH/);
	});

	it('T6. verify-backup phát hiện câu lệnh nguy hiểm trong dump', () => {
		const dir = mkdtempSync(join(tmpdir(), 'alkcloud-chaos-backup-'));
		try {
			const dump = join(dir, 'evil.sql');
			writeFileSync(
				dump,
				`CREATE TABLE owner (id TEXT PRIMARY KEY);
INSERT INTO "owner" ("id") VALUES('own_evil');
ATTACH DATABASE '/etc/passwd' AS leak;
DROP DATABASE production;
PRAGMA writable_schema=ON;
`,
				'utf8',
			);
			const result = runScript('scripts/verify-backup.ts', [dump]);
			assert.notEqual(result.status, 0, 'dump nguy hiểm phải bị từ chối');
			const output = result.stdout + result.stderr;
			assert.match(output, /ATTACH DATABASE|DROP DATABASE|PRAGMA/);
		} finally {
			rmSync(dir, { recursive: true, force: true });
		}
	});

	it('T7. verify-backup từ chối file không phải SQL dump', () => {
		const dir = mkdtempSync(join(tmpdir(), 'alkcloud-chaos-backup-'));
		try {
			const dump = join(dir, 'not-a-dump.sql');
			writeFileSync(dump, 'hello world, this is not a SQL dump', 'utf8');
			const result = runScript('scripts/verify-backup.ts', [dump]);
			assert.notEqual(result.status, 0);
			assert.match(result.stdout + result.stderr, /CREATE TABLE|dump/);
		} finally {
			rmSync(dir, { recursive: true, force: true });
		}
	});

	it('T8. dump hỏng (thiếu bảng bắt buộc) bị verify-backup phát hiện', () => {
		const dir = mkdtempSync(join(tmpdir(), 'alkcloud-chaos-backup-'));
		try {
			const dump = join(dir, 'partial.sql');
			writeFileSync(dump, 'CREATE TABLE owner (id TEXT PRIMARY KEY);\n', 'utf8');
			const result = runScript('scripts/verify-backup.ts', [dump]);
			assert.notEqual(result.status, 0);
			assert.match(result.stdout + result.stderr, /thiếu|missing|bảng/i);
		} finally {
			rmSync(dir, { recursive: true, force: true });
		}
	});

	it('T9. splitDump tách đúng khi dump có bảng con FK trước bảng cha', () => {
		const dump = `CREATE TABLE shares (id TEXT PRIMARY KEY, file_id TEXT REFERENCES files(id));
INSERT INTO "shares" ("id","file_id") VALUES('s1','f1');
CREATE TABLE files (id TEXT PRIMARY KEY);
INSERT INTO "files" ("id") VALUES('f1');
`;
		const { schema, data } = splitDump(dump);
		const schemaStatements = schema.split(';').filter((s) => s.trim());
		const dataStatements = data.split(';').filter((s) => s.trim());
		assert.equal(schemaStatements.length, 2);
		assert.equal(dataStatements.length, 3, '1 PRAGMA + 2 INSERT');
		// Bảng cha phải tồn tại trước khi nạp bảng con.
		assert.ok(schema.includes('CREATE TABLE files'));
		assert.ok(data.includes('INSERT INTO "shares"'));
	});

	it('T10. countRows không đếm nhầm cột liệt kê trong ngoặc', () => {
		const dump = `INSERT INTO "owner" ("id","email","name") VALUES('o1','a@b.c','Tên');
`;
		const counts = countRows(dump);
		assert.equal(counts.get('owner'), 1, '3 cột KHÔNG phải 3 dòng');
	});

	it('T11. DANGEROUS_PATTERNS bắt được các câu lệnh nguy hiểm', () => {
		const samples = [
			'ATTACH DATABASE \'/tmp/x\' AS y',
			'DROP DATABASE prod',
			'PRAGMA writable_schema=ON',
			'VACUUM',
		];
		for (const sample of samples) {
			assert.ok(
				DANGEROUS_PATTERNS.some((rule) => rule.pattern.test(sample)),
				`phải bắt được: ${sample}`,
			);
		}
	});

	it('T12. listTables đọc đủ bảng kể cả khi tên bảng có dấu nháy kép', () => {
		const dump = 'CREATE TABLE "files" (id TEXT);\nCREATE TABLE IF NOT EXISTS `folders` (id TEXT);\n';
		const tables = listTables(dump);
		assert.ok(tables.includes('files'), `thiếu files: ${tables.join(',')}`);
		assert.ok(tables.includes('folders'), `thiếu folders: ${tables.join(',')}`);
	});
});
