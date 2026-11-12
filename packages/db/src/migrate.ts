import type { SqlDriver } from './driver.js';

export interface MigrationFile {
	version: string;
	name: string;
	sql: string;
}

export interface MigrationResult {
	applied: string[];
	skipped: string[];
}

/** Đọc các file `NNNN_name.sql` từ thư mục migrations (dùng cho cả D1 lẫn SQLite). */
export function parseMigrationFiles(files: { name: string; content: string }[]): MigrationFile[] {
	return files
		.map((file) => {
			const match = /^(\d+)_(.+)\.sql$/.exec(file.name);
			if (!match) return null;
			return {
				version: match[1]!,
				name: match[2]!,
				sql: file.content,
			};
		})
		.filter((value): value is MigrationFile => value !== null)
		.sort((a, b) => a.version.localeCompare(b.version));
}

export async function ensureMigrationsTable(driver: SqlDriver): Promise<void> {
	await driver.exec(
		`CREATE TABLE IF NOT EXISTS _migrations (
			version TEXT PRIMARY KEY,
			name TEXT NOT NULL,
			applied_at TEXT NOT NULL
		);`,
	);
}

export async function appliedMigrations(driver: SqlDriver): Promise<Set<string>> {
	await ensureMigrationsTable(driver);
	const result = await driver.query<{ version: string }>('SELECT version FROM _migrations');
	return new Set(result.rows.map((row) => row.version));
}

/**
 * Áp dụng migration chưa chạy. Mỗi file là một transaction.
 * D1 `exec` chạy nhiều statement trong một lần gọi (atomic theo docs D1).
 */
export async function runMigrations(
	driver: SqlDriver,
	files: { name: string; content: string }[],
): Promise<MigrationResult> {
	const migrations = parseMigrationFiles(files);
	const applied = await appliedMigrations(driver);
	const result: MigrationResult = { applied: [], skipped: [] };

	for (const migration of migrations) {
		if (applied.has(migration.version)) {
			result.skipped.push(`${migration.version}_${migration.name}`);
			continue;
		}
		await driver.exec(migration.sql);
		await driver.query('INSERT INTO _migrations (version, name, applied_at) VALUES (?, ?, ?)', [
			migration.version,
			migration.name,
			new Date().toISOString(),
		]);
		result.applied.push(`${migration.version}_${migration.name}`);
	}

	return result;
}
