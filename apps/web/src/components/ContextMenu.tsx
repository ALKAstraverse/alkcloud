import { useEffect, useLayoutEffect, useRef, useState } from 'react';
import { Icon } from './Icon.js';
import type { MenuItem } from './Menu.js';

export interface ContextMenuProps {
	/** Vị trí mở menu (toạ độ viewport). */
	x: number;
	y: number;
	items: MenuItem[];
	/** Nhãn trợ năng của menu. */
	label: string;
	onClose: () => void;
}

const MENU_WIDTH = 220;
const MENU_ESTIMATE_HEIGHT = 240;
const EDGE_PADDING = 8;

/**
 * Menu ngữ cảnh (chuột phải) — kiểu Google Drive / Nextcloud.
 *
 * Vị trí được chặn trong viewport để menu không bị tràn ra ngoài màn hình
 * (đo kích thước thật sau khi render, fallback dùng ước lượng).
 */
export function ContextMenu({ x, y, items, label, onClose }: ContextMenuProps) {
	const rootRef = useRef<HTMLDivElement>(null);
	const [position, setPosition] = useState({ left: x, top: y });

	useLayoutEffect(() => {
		const node = rootRef.current;
		if (!node) return;
		const rect = node.getBoundingClientRect();
		const maxLeft = window.innerWidth - rect.width - EDGE_PADDING;
		const maxTop = window.innerHeight - rect.height - EDGE_PADDING;
		setPosition({
			left: Math.max(EDGE_PADDING, Math.min(x, maxLeft)),
			top: Math.max(EDGE_PADDING, Math.min(y, maxTop)),
		});
	}, [x, y]);

	useEffect(() => {
		const onPointerDown = (event: MouseEvent) => {
			if (!rootRef.current?.contains(event.target as Node)) onClose();
		};
		const onKeyDown = (event: KeyboardEvent) => {
			if (event.key === 'Escape') onClose();
		};
		const onBlur = () => onClose();
		document.addEventListener('mousedown', onPointerDown);
		document.addEventListener('keydown', onKeyDown);
		window.addEventListener('blur', onBlur);
		window.addEventListener('resize', onBlur);
		return () => {
			document.removeEventListener('mousedown', onPointerDown);
			document.removeEventListener('keydown', onKeyDown);
			window.removeEventListener('blur', onBlur);
			window.removeEventListener('resize', onBlur);
		};
	}, [onClose]);

	return (
		<div
			ref={rootRef}
			className="context-menu"
			role="menu"
			aria-label={label}
			style={{ left: position.left, top: position.top, minWidth: MENU_WIDTH }}
		>
			{items.map((item) =>
				item.divider ? (
					<div key={item.id} className="menu__divider" role="separator" />
				) : (
					<button
						key={item.id}
						type="button"
						role="menuitem"
						className={`menu__item${item.danger ? ' menu__item--danger' : ''}`}
						disabled={item.disabled}
						onClick={() => {
							onClose();
							item.onSelect();
						}}
					>
						{item.icon ? <Icon name={item.icon} /> : null}
						<span>{item.label}</span>
					</button>
				),
			)}
		</div>
	);
}
