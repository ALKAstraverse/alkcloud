import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, it } from 'node:test';
import { listFilesAll } from '../src/lib/api.js';

/**
 * Regression test Phase 9 — web client.
 *
 * 1. `listFilesAll` phải lần theo `nextCursor` ⇒ thấy hết file (API mặc định
 *    100/trang; trước đây web chỉ gọi 1 lần ⇒ file thứ 101 trở đi không bao giờ hiện).
 * 2. Confirm dialog (xoá / purge) phải reset trạng thái `busy` khi mở lại,
 *    nếu không nút xác nhận kẹt ở loading vĩnh viễn sau lần dùng đầu tiên.
 */

const originalFetch = globalThis.fetch;

afterEach(() => {
	globalThis.fetch = originalFetch;
});

interface FileEntry {
	id: string;
	name: string;
}

function stubPagedFetch(pages: Array<{ files: FileEntry[]; nextCursor: string | null }>): {
	calls: string[];
} {
	const calls: string[] = [];
	globalThis.fetch = (async (url: string | URL) => {
		const href = String(url);
		calls.push(href);
		const cursor = new URL(href, 'https://api.test').searchParams.get('cursor');
		const index = cursor === null ? 0 : Number(cursor.replace('cursor-', '')) + 1;
		const page = pages[index] ?? { files: [], nextCursor: null };
		return new Response(JSON.stringify({ files: page.files, mode: 'NORMAL', nextCursor: page.nextCursor }), {
			status: 200,
			headers: { 'content-type': 'application/json' },
		});
	}) as typeof fetch;
	return { calls };
}

describe('web — phân trang danh sách file', () => {
	it('listFilesAll gom hết file qua nhiều trang, không trùng', async () => {
		const { calls } = stubPagedFetch([
			{ files: [{ id: 'f1', name: 'a' }], nextCursor: 'cursor-0' },
			{ files: [{ id: 'f2', name: 'b' }], nextCursor: 'cursor-1' },
			{ files: [{ id: 'f3', name: 'c' }], nextCursor: null },
		]);
		const result = await listFilesAll({});
		assert.deepEqual(
			result.files.map((file) => file.id),
			['f1', 'f2', 'f3'],
		);
		assert.equal(calls.length, 3, 'phải gọi API theo số trang');
		assert.ok(calls[1]?.includes('cursor=cursor-0'), 'trang sau phải gửi cursor');
	});

	it('dừng ngay khi API không còn nextCursor', async () => {
		const { calls } = stubPagedFetch([{ files: [{ id: 'f1', name: 'a' }], nextCursor: null }]);
		const result = await listFilesAll({});
		assert.equal(result.files.length, 1);
		assert.equal(calls.length, 1);
	});
});

describe('web — confirm dialog không bị kẹt loading', () => {
	const source = readFileSync(
		join(fileURLToPath(new URL('.', import.meta.url)), '../src/components/FileDialogs.tsx'),
		'utf8',
	);

	it('DeleteConfirmDialog reset busy khi mở lại', () => {
		assert.match(source, /DeleteConfirmDialog[\s\S]*?useEffect\(\(\) => \{\s*if \(open\) setBusy\(false\);/, 'thiếu reset busy khi mở dialog xoá');
	});

	it('PurgeConfirmDialog reset busy khi mở lại', () => {
		const purgeBlock = source.slice(source.indexOf('export function PurgeConfirmDialog'));
		assert.match(purgeBlock, /useEffect\(\(\) => \{\s*if \(open\) setBusy\(false\);/, 'thiếu reset busy khi mở dialog purge');
	});
});
