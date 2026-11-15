import { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react';
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
	/** Element nhận lại tiêu điểm khi menu đóng (hàng được bấm chuột phải). */
	returnFocus?: HTMLElement | null;
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
export function ContextMenu({ x, y, items, label, onClose, returnFocus }: ContextMenuProps) {
	const rootRef = useRef<HTMLDivElement>(null);
	const [position, setPosition] = useState({ left: x, top: y });

	/** Escape ⇒ đóng và trả tiêu điểm về hàng đã bấm chuột phải. */
	const closeWithFocus = useCallback(() => {
		onClose();
		returnFocus?.focus({ preventScroll: true });
	}, [onClose, returnFocus]);

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

	// Mở menu ⇒ đưa tiêu điểm vào mục đầu tiên để điều hướng bằng bàn phím.
	useEffect(() => {
		const first = rootRef.current?.querySelector<HTMLButtonElement>('.menu__item:not([disabled])');
		first?.focus({ preventScroll: true });
	}, []);

	useEffect(() => {
		const onPointerDown = (event: MouseEvent) => {
			if (!rootRef.current?.contains(event.target as Node)) onClose();
		};
		const onKeyDown = (event: KeyboardEvent) => {
			if (event.key === 'Escape') closeWithFocus();
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
	}, [onClose, closeWithFocus]);

	const onMenuKeyDown = (event: React.KeyboardEvent) => {
		const options = Array.from(rootRef.current?.querySelectorAll<HTMLButtonElement>('.menu__item:not([disabled])') ?? []);
		if (options.length === 0) return;
		const index = options.indexOf(document.activeElement as HTMLButtonElement);
		switch (event.key) {
			case 'ArrowDown':
				event.preventDefault();
				options[(index + 1 + options.length) % options.length]?.focus();
				break;
			case 'ArrowUp':
				event.preventDefault();
				options[(index - 1 + options.length) % options.length]?.focus();
				break;
			case 'Home':
				event.preventDefault();
				options[0]?.focus();
				break;
			case 'End':
				event.preventDefault();
				options[options.length - 1]?.focus();
				break;
			case 'Tab':
				onClose();
				break;
			default:
				break;
		}
	};

	return (
		<div
			ref={rootRef}
			className="context-menu"
			role="menu"
			aria-label={label}
			onKeyDown={onMenuKeyDown}
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
