/**
 * AlkCloud — phân tích SQL dump của `wrangler d1 export`.
 *
 * Dùng chung cho `verify-backup.ts` và `restore-drill.ts` để hai công cụ luôn
 * đếm giống nhau (tránh tình trạng "verify nói OK nhưng restore nói FAIL").
 *
 * Định dạng dump của wrangler:
 *   INSERT INTO "_migrations" ("version","name",...) VALUES('0001',...),('0002',...);
 *
 * Lưu ý: cột liệt kê trong ngoặc tròn KHÔNG phải là dữ liệu — chỉ phần sau
 * `VALUES` mới chứa row. Bộ đếm phải bỏ qua phần cột.
 */

/** Tách phần `VALUES ...` của một câu INSERT. */
export function extractValuesClause(body: string): string {
	const upper = body.toUpperCase();
	const index = upper.indexOf(' VALUES');
	if (index < 0) return '';
	return body.slice(index + ' VALUES'.length);
}

/**
 * Đếm số row trong phần VALUES.
 * Bỏ qua ngoặc tròn/string bên trong giá trị.
 */
export function countValueRows(values: string): number {
	let depth = 0;
	let rows = 0;
	let inString = false;
	for (let i = 0; i < values.length; i++) {
		const char = values[i];
		if (inString) {
			if (char === "'") {
				if (values[i + 1] === "'") i += 1;
				else inString = false;
			}
			continue;
		}
		if (char === "'") inString = true;
		else if (char === '(') {
			if (depth === 0) rows += 1;
			depth += 1;
		} else if (char === ')') depth -= 1;
	}
	return rows;
}

/** Danh sách bảng có trong dump. */
export function listTables(sql: string): string[] {
	return [
		...new Set(
			[...sql.matchAll(/CREATE TABLE (?:IF NOT EXISTS )?["`]?([\w]+)["`]?/gi)].map((m) => m[1] ?? ''),
		),
	].filter(Boolean);
}

/**
 * Đếm số row INSERT cho từng bảng trong dump.
 * Dùng cho đối chiếu với `SELECT COUNT(*)` của D1.
 */
export function countRows(sql: string): Map<string, number> {
	const counts = new Map<string, number>();
	const insertRegex = /INSERT\s+INTO\s+["`]?([\w]+)["`]?\s*([\s\S]*?);\s*(?:\n|$)/gi;
	let match: RegExpExecArray | null;
	while ((match = insertRegex.exec(sql)) !== null) {
		const table = match[1];
		if (!table) continue;
		const rows = countValueRows(extractValuesClause(match[2] ?? ''));
		counts.set(table, (counts.get(table) ?? 0) + rows);
	}
	return counts;
}

/** Đếm số câu lệnh INSERT (không phải số row) — dùng để chẩn đoán. */
export function countInsertStatements(sql: string): Map<string, number> {
	const counts = new Map<string, number>();
	const insertRegex = /INSERT\s+INTO\s+["`]?([\w]+)["`]?/gi;
	let match: RegExpExecArray | null;
	while ((match = insertRegex.exec(sql)) !== null) {
		const table = match[1];
		if (!table) continue;
		counts.set(table, (counts.get(table) ?? 0) + 1);
	}
	return counts;
}

/**
 * Tách SQL thành từng câu lệnh, tôn trọng string literal.
 * Dùng cho việc chia dump thành 2 pha (schema → data).
 */
export function splitStatements(sql: string): string[] {
	const statements: string[] = [];
	let current = '';
	let inString = false;
	for (let i = 0; i < sql.length; i++) {
		const char = sql[i] ?? '';
		if (inString) {
			current += char;
			if (char === "'") {
				if (sql[i + 1] === "'") {
					current += sql[i + 1];
					i += 1;
				} else inString = false;
			}
			continue;
		}
		if (char === "'") {
			inString = true;
			current += char;
			continue;
		}
		if (char === ';') {
			const trimmed = current.trim();
			if (trimmed) statements.push(`${trimmed};`);
			current = '';
			continue;
		}
		current += char;
	}
	const tail = current.trim();
	if (tail) statements.push(`${tail};`);
	return statements;
}

/** Phân loại một câu lệnh là schema hay data. */
export function isSchemaStatement(statement: string): boolean {
	return /^\s*CREATE\s+(TABLE|INDEX|UNIQUE\s+INDEX|VIRTUAL\s+TABLE|TRIGGER|VIEW)/i.test(statement);
}

/**
 * Chia dump thành 2 pha để restore được an toàn.
 *
 * VÌ SAO CẦN: `wrangler d1 export` sinh dump theo thứ tự CREATE TABLE rồi INSERT
 * ngay sau đó, nhưng bảng cha (vd `files`) có thể được tạo SAU bảng con
 * (vd `shares` có FK tới `files`). Khi nạp cả dump trong 1 lệnh, SQLite báo
 * `no such table: main.files` ngay lúc prepare câu INSERT (FK được resolve
 * lúc prepare, không phải lúc commit).
 *
 * ⇒ PHẢI nạp schema trước, rồi mới nạp data.
 */
export function splitDump(sql: string): { schema: string; data: string } {
	const statements = splitStatements(sql);
	const schemaStatements: string[] = [];
	const dataStatements: string[] = [];
	for (const statement of statements) {
		if (isSchemaStatement(statement)) schemaStatements.push(statement);
		else dataStatements.push(statement);
	}
	return {
		schema: `${schemaStatements.join('\n')}\n`,
		data: `PRAGMA defer_foreign_keys=TRUE;\n${dataStatements.join('\n')}\n`,
	};
}

/** Liệt kê câu lệnh có rủi ro trong dump (không được phép xuất hiện). */
export const DANGEROUS_PATTERNS: Array<{ pattern: RegExp; reason: string }> = [
	{ pattern: /ATTACH\s+DATABASE/i, reason: 'ATTACH DATABASE có thể đọc/ghi file ngoài' },
	{ pattern: /DROP\s+DATABASE/i, reason: 'DROP DATABASE' },
	{ pattern: /PRAGMA\s+(?!defer_foreign_keys|foreign_keys|journal_mode)/i, reason: 'PRAGMA ghi (vd writable_schema)' },
	{ pattern: /\bVACUUM\b/i, reason: 'VACUUM có thể thay đổi file DB' },
];
