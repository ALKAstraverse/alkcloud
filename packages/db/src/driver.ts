export interface SqlStatement {
	sql: string;
	params?: unknown[];
}

export interface SqlMeta {
	changes?: number;
	lastRowId?: number;
	rowsRead?: number;
	rowsWritten?: number;
}

export interface SqlResult<T = Record<string, unknown>> {
	rows: T[];
	meta: SqlMeta;
}

/**
 * Port tối thiểu cho D1. Cho phép test bằng SQLite cục bộ (xem `sqlite.ts`)
 * mà không đổi code nghiệp vụ.
 */
export interface SqlDriver {
	query<T = Record<string, unknown>>(sql: string, params?: unknown[]): Promise<SqlResult<T>>;
	/** Statement ghi (INSERT/UPDATE/DELETE) — trả về meta.changes để kiểm tra atomicity. */
	run(sql: string, params?: unknown[]): Promise<SqlMeta>;
	/** Thực thi nhiều statement trong một transaction (D1 `batch` là atomic). */
	batch(statements: SqlStatement[]): Promise<SqlResult[]>;
	exec(sql: string): Promise<void>;
	close?(): void;
}

interface D1ResultMeta {
	changes?: number;
	last_row_id?: number;
	rows_read?: number;
	rows_written?: number;
}

interface D1PreparedStatement {
	bind(...values: unknown[]): D1PreparedStatement;
	all<T = Record<string, unknown>>(): Promise<{ results: T[]; meta?: D1ResultMeta }>;
	run(): Promise<{ meta?: D1ResultMeta }>;
}

interface D1Like {
	prepare(sql: string): D1PreparedStatement;
	batch(statements: unknown[]): Promise<unknown[]>;
	exec(sql: string): Promise<unknown>;
}

export class D1Driver implements SqlDriver {
	constructor(private readonly db: D1Like) {}

	async query<T = Record<string, unknown>>(
		sql: string,
		params: unknown[] = [],
	): Promise<SqlResult<T>> {
		const prepared = params.length > 0 ? this.db.prepare(sql).bind(...params) : this.db.prepare(sql);
		const result = await prepared.all<T>();
		return {
			rows: result.results ?? [],
			meta: {
				changes: result.meta?.changes,
				lastRowId: result.meta?.last_row_id,
				rowsRead: result.meta?.rows_read,
				rowsWritten: result.meta?.rows_written,
			},
		};
	}

	async run(sql: string, params: unknown[] = []): Promise<SqlMeta> {
		const prepared = params.length > 0 ? this.db.prepare(sql).bind(...params) : this.db.prepare(sql);
		const result = await prepared.run();
		return {
			changes: result.meta?.changes,
			lastRowId: result.meta?.last_row_id,
		};
	}

	async batch(statements: SqlStatement[]): Promise<SqlResult[]> {
		const prepared = statements.map((statement) =>
			statement.params && statement.params.length > 0
				? this.db.prepare(statement.sql).bind(...statement.params)
				: this.db.prepare(statement.sql),
		);
		const results = (await this.db.batch(prepared)) as Array<{
			results?: Record<string, unknown>[];
			meta?: { changes?: number; last_row_id?: number };
		}>;
		return results.map((result) => ({
			rows: result.results ?? [],
			meta: { changes: result.meta?.changes, lastRowId: result.meta?.last_row_id },
		}));
	}

	async exec(sql: string): Promise<void> {
		await this.db.exec(sql);
	}
}
