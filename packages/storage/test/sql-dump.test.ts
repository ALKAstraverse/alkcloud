import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import {
	countRows,
	countValueRows,
	extractValuesClause,
	isSchemaStatement,
	listTables,
	splitDump,
	splitStatements,
} from '../../db/src/sql-dump.js';

const DUMP = `PRAGMA defer_foreign_keys=TRUE;
CREATE TABLE owner (
  id TEXT PRIMARY KEY,
  email TEXT NOT NULL UNIQUE
);
INSERT INTO "owner" ("id","email") VALUES('own_1','a@b.c');
CREATE TABLE files (
  id TEXT PRIMARY KEY,
  folder_id TEXT REFERENCES folders(id) ON DELETE SET NULL
);
INSERT INTO "files" ("id","folder_id") VALUES('fil_1',NULL),('fil_2','fld_1');
CREATE TABLE shares (
  id TEXT PRIMARY KEY,
  file_id TEXT NOT NULL REFERENCES files(id)
);
INSERT INTO "shares" ("id","file_id") VALUES('shr_1','fil_1');
CREATE INDEX idx_files_folder ON files(folder_id);
`;

describe('P4 — sql dump: splitStatements', () => {
	it('tách được các câu lệnh theo dấu ;', () => {
		const statements = splitStatements(DUMP);
		assert.equal(statements.length, 8);
		assert.ok(statements[0]?.startsWith('PRAGMA'));
		assert.ok(statements[1]?.startsWith('CREATE TABLE owner'));
	});

	it('không tách sai khi có dấu ; trong string literal', () => {
		const statements = splitStatements(
			"INSERT INTO t (a) VALUES('x;y');\nCREATE TABLE u (id TEXT);",
		);
		assert.equal(statements.length, 2);
		assert.ok(statements[0]?.includes("'x;y'"));
	});

	it('giữ escape dấu nháy kép trong string', () => {
		const statements = splitStatements("INSERT INTO t (a) VALUES('it''s; fine');");
		assert.equal(statements.length, 1);
	});
});

describe('P4 — sql dump: đếm row', () => {
	it('bỏ qua cột liệt kê trong ngoặc, chỉ đếm row VALUES', () => {
		assert.equal(countValueRows(extractValuesClause('("id","email") VALUES(\'a\')')), 1);
	});

	it('đếm đúng nhiều row trong 1 câu INSERT', () => {
		assert.equal(countValueRows(extractValuesClause('("a","b") VALUES(\'1\',\'2\'),(\'3\',\'4\')')), 2);
	});

	it('countRows trả về số row theo bảng', () => {
		const counts = countRows(DUMP);
		assert.equal(counts.get('owner'), 1);
		assert.equal(counts.get('files'), 2);
		assert.equal(counts.get('shares'), 1);
	});

	it('listTables liệt kê đúng bảng', () => {
		assert.deepEqual(listTables(DUMP).sort(), ['files', 'owner', 'shares']);
	});
});

describe('P4 — sql dump: phân loại câu lệnh', () => {
	it('nhận diện schema vs data', () => {
		assert.equal(isSchemaStatement('CREATE TABLE x (id TEXT);'), true);
		assert.equal(isSchemaStatement('CREATE INDEX i ON x(id);'), true);
		assert.equal(isSchemaStatement('INSERT INTO x VALUES(1);'), false);
		assert.equal(isSchemaStatement('PRAGMA defer_foreign_keys=TRUE;'), false);
	});
});

describe('P4 — sql dump: splitDump (fix bug restore production)', () => {
	it('tách schema và data, giữ thứ tự CREATE trước INSERT', () => {
		const { schema, data } = splitDump(DUMP);
		const schemaStatements = splitStatements(schema);
		const dataStatements = splitStatements(data);

		// mọi CREATE phải nằm trong file schema
		for (const statement of schemaStatements) {
			assert.ok(isSchemaStatement(statement), `file schema chứa câu lệnh không phải schema: ${statement}`);
		}
		// mọi INSERT phải nằm trong file data
		for (const statement of dataStatements) {
			assert.equal(isSchemaStatement(statement), false);
		}
		// không mất bảng nào
		assert.deepEqual(listTables(schema).sort(), ['files', 'owner', 'shares']);
	});

	it('data bắt đầu bằng PRAGMA defer_foreign_keys để FK check hoãn tới COMMIT', () => {
		const { data } = splitDump(DUMP);
		assert.ok(data.startsWith('PRAGMA defer_foreign_keys=TRUE;'));
	});

	it('nạp schema trước làm bảng cha tồn tại trước khi INSERT bảng con (FK)', () => {
		// BUG gốc: `shares` có FK tới `files`, nhưng dump tạo `shares` TRƯỚC `files`
		// trong thực tế (wrangler export theo thứ tự bảng). Nếu nạp 1 pha,
		// SQLite lỗi "no such table: main.files" lúc prepare.
		const unordered = `CREATE TABLE shares (id TEXT PRIMARY KEY, file_id TEXT REFERENCES files(id));
INSERT INTO "shares" ("id","file_id") VALUES('shr_1','fil_1');
CREATE TABLE files (id TEXT PRIMARY KEY);
INSERT INTO "files" ("id") VALUES('fil_1');
`;
		const { schema, data } = splitDump(unordered);
		// Sau khi tách: nạp schema xong thì `files` đã tồn tại ⇒ INSERT `shares` hợp lệ.
		assert.ok(schema.includes('CREATE TABLE files'));
		assert.ok(data.includes('INSERT INTO "shares"'));
	});
});
