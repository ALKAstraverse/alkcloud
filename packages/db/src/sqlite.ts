import { DatabaseSync } from 'node:sqlite';
import type { SqlDriver, SqlMeta, SqlResult, SqlStatement } from './driver.js';

/**
 * Adapter SQLite cục bộ (node:sqlite, Node >= 22.5) — dùng cho test và local dev.
 * File này KHÔNG được import từ Worker bundle (apps/api) để tránh kéo `node:sqlite` vào Workers.
 */
export class SqliteDriver implements SqlDriver {
	private readonly db: DatabaseSync;

	constructor(databasePath = ':memory:') {
		this.db = new DatabaseSync(databasePath);
		this.db.exec('PRAGMA journal_mode = WAL; PRAGMA foreign_keys = ON;');
	}

	async query<T = Record<string, unknown>>(
		sql: string,
		params: unknown[] = [],
	): Promise<SqlResult<T>> {
		const stmt = this.db.prepare(sql);
		const rows = stmt.all(...(params as never[])) as T[];
		return { rows, meta: { rowsRead: rows.length } };
	}

	async run(sql: string, params: unknown[] = []): Promise<SqlMeta> {
		const stmt = this.db.prepare(sql);
		const info = stmt.run(...(params as never[]));
		return { changes: Number(info.changes), lastRowId: Number(info.lastInsertRowid) };
	}

	async batch(statements: SqlStatement[]): Promise<SqlResult[]> {
		this.db.exec('BEGIN');
		try {
			const results: SqlResult[] = [];
			for (const statement of statements) {
				const stmt = this.db.prepare(statement.sql);
				const info = stmt.run(...((statement.params ?? []) as never[]));
				results.push({
					rows: [],
					meta: {
						changes: Number(info.changes),
						lastRowId: Number(info.lastInsertRowid),
					},
				});
			}
			this.db.exec('COMMIT');
			return results;
		} catch (error) {
			this.db.exec('ROLLBACK');
			throw error;
		}
	}

	async exec(sql: string): Promise<void> {
		this.db.exec(sql);
	}

	close(): void {
		this.db.close();
	}
}
