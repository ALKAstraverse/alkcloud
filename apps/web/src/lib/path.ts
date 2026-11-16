/**
 * Helper hiển thị đường dẫn thư mục — rút gọn kiểu Explorer/Windows:
 * đường dẫn dài ⇒ giữ phần **cuối** và thêm "…" ở đầu ("…/to/folder").
 */

/** Ghép các đoạn tên thư mục thành đường dẫn tuyệt đối ("/A/B/C"). */
export function buildPath(segments: Array<string | null | undefined>): string {
	const parts = segments.filter((segment): segment is string => Boolean(segment && segment.trim()));
	return parts.length === 0 ? '/' : `/${parts.map((part) => part.trim()).join('/')}`;
}

/**
 * Rút gọn đường dẫn để vừa một dòng.
 *
 * - `maxLength <= 0` ⇒ không rút gọn.
 * - Luôn giữ phần cuối (thư mục đích) vì đó là phần người dùng cần đọc.
 */
export function shortenPath(path: string, maxLength = 40): string {
	if (maxLength <= 0 || path.length <= maxLength) return path;
	if (path === '/') return path;
	const segments = path.split('/').filter(Boolean);
	if (segments.length === 0) return path;

	const tail: string[] = [];
	let length = 0;
	for (let index = segments.length - 1; index >= 0; index -= 1) {
		const segment = segments[index]!;
		const next = length + segment.length + (tail.length > 0 ? 1 : 0);
		if (next > maxLength - 2 && tail.length > 0) break;
		tail.unshift(segment);
		length = next;
		if (length >= maxLength - 2) break;
	}
	const suffix = tail.join('/');
	if (suffix === path) return path;
	const prefix = '…/';
	const budget = maxLength - prefix.length;
	if (suffix.length <= budget) return prefix + suffix;
	// Tên đơn quá dài ⇒ cắt giữa, giữ cả đầu lẫn cuối ("ten-th…-dai").
	const head = Math.ceil((budget - 1) / 2);
	const tailLength = budget - 1 - head;
	return `${prefix}${suffix.slice(0, head)}…${suffix.slice(suffix.length - tailLength)}`;
}

/** Đường dẫn tới một node trong cây (theo chuỗi cha). */
export function pathOfNode(
	nodeId: string | null,
	byId: Map<string, { id: string; name: string; parentId: string | null }>,
): string {
	const segments: string[] = [];
	let current = nodeId ? byId.get(nodeId) : undefined;
	const guard = new Set<string>();
	while (current && !guard.has(current.id)) {
		guard.add(current.id);
		segments.unshift(current.name);
		current = current.parentId ? byId.get(current.parentId) : undefined;
	}
	return buildPath(segments);
}
