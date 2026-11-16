import assert from 'node:assert/strict';
import { test } from 'node:test';
import { collectSubtreeIds, filterCollapsed, orderFolderTree, type FolderTreeNode } from '../src/lib/folder-tree.js';

const tree: FolderTreeNode[] = [
	{ id: 'b', name: 'B', parentId: 'a', depth: 1 },
	{ id: 'c', name: 'C', parentId: null, depth: 0 },
	{ id: 'a', name: 'A', parentId: null, depth: 0 },
	{ id: 'b1', name: 'B1', parentId: 'b', depth: 2 },
	{ id: 'b2', name: 'B2', parentId: 'b', depth: 2 },
	{ id: 'a1', name: 'A1', parentId: 'a', depth: 1 },
];

test('orderFolderTree đặt thư mục con ngay dưới thư mục mẹ', () => {
	const ordered = orderFolderTree(tree);
	assert.deepEqual(
		ordered.map((node) => node.id),
		['a', 'a1', 'b', 'b1', 'b2', 'c'],
		'cha phải đứng trước con, con nằm liền nhau',
	);
});

test('orderFolderTree sort cùng cấp theo tên', () => {
	const ordered = orderFolderTree(tree);
	const rootLevel = ordered.filter((node) => node.parentId === null).map((node) => node.name);
	assert.deepEqual(rootLevel, ['A', 'C']);
});

test('orderFolderTree giữ node mồ côi ở cuối, không làm mất node', () => {
	const withOrphan: FolderTreeNode[] = [...tree, { id: 'x', name: 'X', parentId: 'khong-ton-tai' }];
	const ordered = orderFolderTree(withOrphan);
	assert.equal(ordered.length, withOrphan.length);
	assert.equal(ordered[ordered.length - 1]?.id, 'x');
});

test('collectSubtreeIds gom node + toàn bộ nhánh con cháu', () => {
	const blocked = collectSubtreeIds(tree, 'b');
	assert.deepEqual([...blocked].sort(), ['b', 'b1', 'b2']);
	assert.equal(blocked.has('a'), false);
	assert.equal(collectSubtreeIds(tree, null).size, 0);
});

test('filterCollapsed ẩn cả nhánh con cháu khi thu gọn', () => {
	const ordered = orderFolderTree(tree);
	const visible = filterCollapsed(ordered, new Set(['b']));
	assert.deepEqual(
		visible.map((node) => node.id),
		['a', 'a1', 'b', 'c'],
		'thu gọn B ⇒ ẩn B1, B2',
	);
});
