#!/usr/bin/env node
/**
 * WS-I — Kiểm tra an toàn & chất lượng mã client (static, dựa trên AST TypeScript).
 *
 * LOẠI: READ_ONLY (chỉ đọc file nguồn, không sửa, không build, không deploy).
 *
 * Vì sao dùng AST thay vì `grep`:
 * - `grep "password:"` bắt nhầm biến cục bộ, tham số hàm, JSX `value={password}`.
 * - Nguy hiểm thật là **object literal có key `password`** (mật khẩu thô nằm
 *   trong payload gửi lên server) — chỉ AST mới phân biệt chính xác.
 *
 * Các kiểm tra:
 *   W1. Object literal có key `password` (mật khẩu thô trong payload).
 *   W2. `dangerouslySetInnerHTML` (XSS).
 *   W3. `eval()` / `new Function()` (thực thi code động).
 *   W4. Gán `innerHTML` / `outerHTML`.
 *   W5. `localStorage` / `sessionStorage` (rò phiên).
 *   W6. Chuỗi trông giống secret hardcode.
 *   W7. `console.log`/`console.info`/`console.debug` trong mã runtime.
 *
 * Dùng: npm run check:web
 */
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import ts from 'typescript';

const HERE = dirnameSafe(fileURLToPath(import.meta.url));
const WEB_SRC = resolve(HERE, '../apps/web/src');

function dirnameSafe(path: string): string {
	const index = path.lastIndexOf('/');
	return index > 0 ? path.slice(0, index) : path;
}

interface Finding {
	rule: string;
	file: string;
	line: number;
	column: number;
	message: string;
}

const findings: Finding[] = [];

/**
 * "Sink" = hàm client đưa dữ liệu lên server.
 *
 * W1 chỉ bắt vi phạm khi object literal chứa `password` được truyền vào một
 * sink. Ví dụ `argon2id({ password, salt })` là HASH CỤC BỘ (hash-wasm) ⇒ hợp lệ.
 * Danh sách sink được suy ra tự động từ `apps/web/src/lib/api.ts`: mọi hàm
 * export có gọi `apiRequest` bên trong.
 */
const API_SINKS = new Set<string>();

function collectApiSinks(file: string): void {
	const source = readFileSync(file, 'utf8');
	const sourceFile = ts.createSourceFile(
		file,
		source,
		ts.ScriptTarget.ES2022,
		true,
		ts.ScriptKind.TS,
	);
	const callsApiRequest = (node: ts.Node): boolean => {
		let found = false;
		const walk = (child: ts.Node) => {
			if (
				ts.isCallExpression(child) &&
				ts.isIdentifier(child.expression) &&
				child.expression.text === 'apiRequest'
			) {
				found = true;
			}
			ts.forEachChild(child, walk);
		};
		walk(node);
		return found;
	};
	sourceFile.forEachChild((node) => {
		if (
			ts.isFunctionDeclaration(node) &&
			node.name &&
			node.modifiers?.some((modifier) => modifier.kind === ts.SyntaxKind.ExportKeyword) &&
			callsApiRequest(node)
		) {
			API_SINKS.add(node.name.text);
		}
	});
}

function listFiles(dir: string): string[] {
	const out: string[] = [];
	for (const entry of readdirSync(dir)) {
		const full = join(dir, entry);
		if (statSync(full).isDirectory()) out.push(...listFiles(full));
		else if (/\.(ts|tsx)$/.test(entry)) out.push(full);
	}
	return out;
}

function relative(file: string): string {
	return file.replace(`${resolve(HERE, '..')}/`, '');
}

function propertyNameText(name: ts.PropertyName | undefined): string | null {
	if (!name) return null;
	if (ts.isIdentifier(name)) return name.text;
	if (ts.isStringLiteral(name) || ts.isNoSubstitutionTemplateLiteral(name)) return name.text;
	return null;
}

const SECRET_KEY_NAME = /(?:secret|api[_-]?key|access[_-]?key|private[_-]?key|password|token|pepper)/i;
const SECRET_LITERAL = /(?:secret|api[_-]?key|access[_-]?key|private[_-]?key|password|token)['"]?\s*[:=]\s*['"][A-Za-z0-9_/+=-]{20,}/i;

function analyze(file: string, source: string): void {
	const sourceFile = ts.createSourceFile(
		file,
		source,
		ts.ScriptTarget.ES2022,
		true,
		file.endsWith('.tsx') ? ts.ScriptKind.TSX : ts.ScriptKind.TS,
	);
	const report = (rule: string, node: ts.Node, message: string) => {
		const { line, character } = sourceFile.getLineAndCharacterOfPosition(node.getStart(sourceFile));
		findings.push({
			rule,
			file: relative(file),
			line: line + 1,
			column: character + 1,
			message,
		});
	};

	const visit = (node: ts.Node): void => {
		// W1 — object literal có key `password` được truyền vào hàm gửi API.
		if (ts.isCallExpression(node) && ts.isIdentifier(node.expression) && API_SINKS.has(node.expression.text)) {
			for (const argument of node.arguments) {
				if (ts.isObjectLiteralExpression(argument)) {
					for (const property of argument.properties) {
						if (propertyNameText(property.name) === 'password') {
							report(
								'W1',
								property,
								`object literal có key \`password\` được truyền vào ${node.expression.text}() — mật khẩu thô không được gửi lên API`,
							);
						}
					}
				}
			}
		}

		// W2 — dangerouslySetInnerHTML.
		if (
			ts.isJsxAttribute(node) &&
			ts.isIdentifier(node.name) &&
			node.name.text === 'dangerouslySetInnerHTML'
		) {
			report('W2', node, 'JSX dùng dangerouslySetInnerHTML — rủi ro XSS');
		}

		// W3 — eval / new Function.
		if (
			ts.isCallExpression(node) &&
			ts.isIdentifier(node.expression) &&
			node.expression.text === 'eval'
		) {
			report('W3', node, 'gọi eval() — thực thi code động');
		}
		if (
			ts.isNewExpression(node) &&
			ts.isIdentifier(node.expression) &&
			node.expression.text === 'Function'
		) {
			report('W3', node, 'new Function() — thực thi code động');
		}

		// W4 — gán innerHTML / outerHTML.
		if (ts.isBinaryExpression(node) && node.operatorToken.kind === ts.SyntaxKind.EqualsToken) {
			const left = node.left;
			if (ts.isPropertyAccessExpression(left)) {
				const name = left.name.text;
				if (name === 'innerHTML' || name === 'outerHTML') {
					report('W4', node, `gán trực tiếp ${name} — có thể dẫn tới XSS`);
				}
			}
		}

		// W5 — localStorage / sessionStorage.
		if (
			ts.isPropertyAccessExpression(node) &&
			(ts.isIdentifier(node.expression) || ts.isPropertyAccessExpression(node.expression))
		) {
			const root = ts.isIdentifier(node.expression)
				? node.expression.text
				: ts.isPropertyAccessExpression(node.expression) && ts.isIdentifier(node.expression.expression)
					? node.expression.expression.text
					: null;
			if (root === 'localStorage' || root === 'sessionStorage') {
				report('W5', node, `dùng ${root} — không lưu phiên/credential phía client`);
			}
		}

		// W6 — gán giá trị chuỗi dài cho key trông giống secret.
		if (ts.isPropertyAssignment(node) && ts.isStringLiteral(node.initializer)) {
			const name = propertyNameText(node.name);
			if (
				name &&
				SECRET_KEY_NAME.test(name) &&
				node.initializer.text.length >= 20 &&
				!/^\$\{/.test(node.initializer.text)
			) {
				report('W6', node, `property \`${name}\` được gán chuỗi dài — có thể là secret hardcode`);
			}
		}

		// W7 — console.log/info/debug.
		if (
			ts.isCallExpression(node) &&
			ts.isPropertyAccessExpression(node.expression) &&
			ts.isIdentifier(node.expression.expression) &&
			node.expression.expression.text === 'console' &&
			['log', 'info', 'debug'].includes(node.expression.name.text)
		) {
			report('W7', node, `console.${node.expression.name.text}() trong mã runtime`);
		}

		ts.forEachChild(node, visit);
	};

	visit(sourceFile);

	// W6 — chuỗi giống secret (chỉ string literal, không phải regex).
	sourceFile.forEachChild((node) => {
		if (ts.isStringLiteral(node) || ts.isNoSubstitutionTemplateLiteral(node)) {
			if (SECRET_LITERAL.test(node.text)) {
				report('W6', node, 'chuỗi trông giống secret được hardcode');
			}
		}
	});
}

/**
 * Chạy kiểm tra trên một tập file (dùng cả cho CLI và cho test tự kiểm).
 */
export function runChecks(files: string[]): Finding[] {
	findings.length = 0;
	API_SINKS.clear();
	collectApiSinks(resolve(HERE, '../apps/web/src/lib/api.ts'));
	for (const file of files) {
		analyze(file, readFileSync(file, 'utf8'));
	}
	return [...findings];
}

export function listWebFiles(): string[] {
	return listFiles(WEB_SRC);
}

function main(): void {
	const files = listWebFiles();
	runChecks(files);

	const rules = new Map<string, string>([
		['W1', 'Mật khẩu thô không được nằm trong payload gửi API'],
		['W2', 'Không dangerouslySetInnerHTML'],
		['W3', 'Không eval / new Function'],
		['W4', 'Không gán innerHTML / outerHTML'],
		['W5', 'Không dùng localStorage / sessionStorage'],
		['W6', 'Không hardcode chuỗi giống secret'],
		['W7', 'Không console.log trong mã runtime'],
	]);

	console.log('');
	console.log('  KIỂM TRA MÃ CLIENT (AST TypeScript)');
	console.log('  ' + '─'.repeat(64));
	for (const [rule, description] of rules) {
		const hits = findings.filter((finding) => finding.rule === rule);
		if (hits.length === 0) {
			console.log(`  \x1b[32m✓\x1b[0m ${rule} — ${description}`);
		} else {
			console.log(`  \x1b[31m✗\x1b[0m ${rule} — ${description} (${hits.length})`);
			for (const hit of hits) {
				console.log(`      ${hit.file}:${hit.line}:${hit.column} — ${hit.message}`);
			}
		}
	}
	console.log('');
	console.log(`  Đã phân tích ${files.length} file trong apps/web/src.`);
	console.log(`  Sink API nhận diện: ${[...API_SINKS].sort().join(', ') || '(không có)'}`);
	console.log('');

	if (findings.length > 0) {
		console.log(`  KẾT QUẢ: FAIL — ${findings.length} vi phạm.`);
		process.exitCode = 1;
		return;
	}
	console.log('  KẾT QUẢ: PASS — không phát hiện vấn đề.');
}

main();
