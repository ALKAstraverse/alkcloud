/**
 * Tiện ích cây thư mục (dùng cho bộ chọn thư mục kiểu Windows).
 */

export interface FolderTreeNode {
	id: string;
	name: string;
	parentId: string | null;
	depth?: number;
}

/**
 * Sắp xếp node theo cây: cha → con, cùng cấp sort theo tên (locale `vi`).
 *
 * Không sort theo `depth` ⇒ thư mục con luôn nằm ngay dưới thư mục mẹ
 * thay vì bị gom về cuối danh sách.
 */
export function orderFolderTree(nodes: FolderTreeNode[]): FolderTreeNode[] {
	const childrenOf = new Map<string | null, FolderTreeNode[]>();
	for (const node of nodes) {
		const list = childrenOf.get(node.parentId) ?? [];
		list.push(node);
		childrenOf.set(node.parentId, list);
	}
	for (const list of childrenOf.values()) {
		list.sort((a, b) => a.name.localeCompare(b.name, 'vi'));
	}

	const result: FolderTreeNode[] = [];
	const visit = (parentId: string | null) => {
		for (const node of childrenOf.get(parentId) ?? []) {
			result.push(node);
			visit(node.id);
		}
	};
	visit(null);

	// Node mồ côi (cha đã xoá / ngoài cây) ⇒ đưa cuối để không bị mất.
	const seen = new Set(result.map((node) => node.id));
	for (const node of nodes) {
		if (!seen.has(node.id)) result.push(node);
	}
	return result;
}

/** Tập id của `rootId` + toàn bộ nhánh con cháu (dùng để chặn move vào chính nó). */
export function collectSubtreeIds(nodes: FolderTreeNode[], rootId: string | null): Set<string> {
	const blocked = new Set<string>();
	if (!rootId) return blocked;
	blocked.add(rootId);
	let changed = true;
	while (changed) {
		changed = false;
		for (const node of nodes) {
			if (node.parentId && blocked.has(node.parentId) && !blocked.has(node.id)) {
				blocked.add(node.id);
				changed = true;
			}
		}
	}
	return blocked;
}

/** Ẩn mọi node nằm dưới node đã thu gọn (theo thứ tự cây đã sắp). */
export function filterCollapsed(nodes: FolderTreeNode[], collapsed: Set<string>): FolderTreeNode[] {
	const hidden = new Set<string>();
	for (const node of nodes) {
		if (!collapsed.has(node.id)) continue;
		for (const child of nodes) {
			if (child.parentId === node.id) hidden.add(child.id);
		}
	}
	let changed = true;
	while (changed) {
		changed = false;
		for (const node of nodes) {
			if (node.parentId && hidden.has(node.parentId) && !hidden.has(node.id)) {
				hidden.add(node.id);
				changed = true;
			}
		}
	}
	return nodes.filter((node) => !hidden.has(node.id));
}
