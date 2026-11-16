import assert from 'node:assert/strict';
import { test } from 'node:test';
import { buildPath, pathOfNode, shortenPath } from '../src/lib/path.js';
import { retentionDeadline } from '../src/lib/format.js';

test('buildPath ghép đường dẫn tuyệt đối', () => {
	assert.equal(buildPath(['A', 'B', 'C']), '/A/B/C');
	assert.equal(buildPath(['A', null, 'C']), '/A/C');
	assert.equal(buildPath([]), '/');
	assert.equal(buildPath([null, undefined]), '/');
});

test('shortenPath giữ nguyên đường dẫn ngắn', () => {
	assert.equal(shortenPath('/A/B/C', 40), '/A/B/C');
	assert.equal(shortenPath('/', 40), '/');
});

test('shortenPath rút gọn từ đầu, giữ phần cuối', () => {
	const path = '/path/to/folder/with/a/very/long/name/inside';
	const short = shortenPath(path, 20);
	assert.ok(short.startsWith('…/'), `phải bắt đầu bằng …/, nhận ${short}`);
	assert.ok(short.endsWith('inside'), `phải giữ phần cuối, nhận ${short}`);
	assert.ok(short.length <= 20, `độ dài phải <= 20, nhận ${short.length}`);
});

test('shortenPath cắt giữa khi tên thư mục quá dài', () => {
	const short = shortenPath('/ten-thu-muc-rat-dai', 12);
	assert.ok(short.length <= 12, `độ dài phải <= 12, nhận ${short.length}`);
	assert.ok(short.startsWith('…/'), `phải bắt đầu bằng …/, nhận ${short}`);
	assert.ok(short.includes('…'), `phải có dấu cắt giữa, nhận ${short}`);
});

test('pathOfNode dựng đường dẫn theo chuỗi cha', () => {
	const byId = new Map([
		['1', { id: '1', name: 'A', parentId: null }],
		['2', { id: '2', name: 'B', parentId: '1' }],
		['3', { id: '3', name: 'C', parentId: '2' }],
	]);
	assert.equal(pathOfNode('3', byId), '/A/B/C');
	assert.equal(pathOfNode(null, byId), '/');
	assert.equal(pathOfNode('missing', byId), '/');
});

test('retentionDeadline tính mốc hết hạn giữ cho thư mục', () => {
	assert.equal(retentionDeadline('2026-01-01T00:00:00.000Z', 30), '2026-01-31T00:00:00.000Z');
	assert.equal(retentionDeadline(null, 30), null);
	assert.equal(retentionDeadline('không-hợp-lệ', 30), null);
});
