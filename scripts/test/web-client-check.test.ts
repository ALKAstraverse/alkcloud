import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { listWebFiles, runChecks } from '../check-web-client-security.js';

/**
 * WS-I — tự kiểm bộ kiểm tra mã client.
 *
 * Một static check không có test là một check **không đáng tin** (nó có thể
 * im lặng vì regex hỏng, vì parse fail, vì đường dẫn sai). Test này chứng minh
 * từng quy tắc BẮT ĐƯỢC vi phạm thật.
 */

const BAD_SOURCE = `
import { createShare } from './api.js';

export function bad(password: string) {
	localStorage.setItem('authKey', 'x');
	document.getElementById('x')!.innerHTML = '<b>hi</b>';
	eval('1+1');
	const f = new Function('return 1');
	const secret = { apiKey: 'ABCDEFGHIJKLMNOPQRSTUVWXYZ012345' };
	console.log('debug');
	return createShare({ fileId: 'f1', password });
}
`;

const BAD_TSX = `
export function Bad() {
	return <div dangerouslySetInnerHTML={{ __html: '<b>x</b>' }} />;
}
`;

describe('WS-I — tự kiểm bộ kiểm tra client', () => {
	it('bắt được mọi vi phạm trong file mẫu', () => {
		const dir = mkdtempSync(join(tmpdir(), 'alkcloud-web-check-'));
		const file = join(dir, 'bad.ts');
		writeFileSync(file, BAD_SOURCE);
		const findings = runChecks([file]);
		const rules = new Set(findings.map((finding) => finding.rule));

		assert.ok(rules.has('W1'), 'W1 — mật khẩu thô trong payload API');
		assert.ok(rules.has('W3'), 'W3 — eval / new Function');
		assert.ok(rules.has('W4'), 'W4 — gán innerHTML');
		assert.ok(rules.has('W5'), 'W5 — localStorage');
		assert.ok(rules.has('W6'), 'W6 — secret hardcode');
		assert.ok(rules.has('W7'), 'W7 — console.log');
	});

	it('bắt được dangerouslySetInnerHTML trong JSX', () => {
		const dir = mkdtempSync(join(tmpdir(), 'alkcloud-web-check-'));
		const file = join(dir, 'bad.tsx');
		writeFileSync(file, BAD_TSX);
		const findings = runChecks([file]);
		assert.ok(findings.some((finding) => finding.rule === 'W2'), 'W2 — dangerouslySetInnerHTML');
	});

	it('mã client thật của repo KHÔNG có vi phạm', () => {
		const findings = runChecks(listWebFiles());
		assert.equal(
			findings.length,
			0,
			`mã client thật có vi phạm: ${findings.map((finding) => `${finding.rule} ${finding.file}:${finding.line}`).join(', ')}`,
		);
	});

	it('KHÔNG báo nhầm khi mật khẩu chỉ dùng để hash cục bộ', () => {
		const dir = mkdtempSync(join(tmpdir(), 'alkcloud-web-check-'));
		const file = join(dir, 'hash.ts');
		writeFileSync(
			file,
			`import { argon2id } from 'hash-wasm';
			 export async function h(password: string, salt: Uint8Array) {
			   return argon2id({ password, salt, parallelism: 1, iterations: 2, memorySize: 19456, hashLength: 32, outputType: 'binary' });
			 }`,
		);
		const findings = runChecks([file]);
		assert.equal(
			findings.filter((finding) => finding.rule === 'W1').length,
			0,
			'hash cục bộ không phải payload API ⇒ không được báo W1',
		);
	});
});
