import { useEffect, useId, useRef, useState, type ReactNode } from 'react';
import { Icon, type IconName } from './Icon.js';

export interface MenuItem {
	id: string;
	label: string;
	icon?: IconName;
	danger?: boolean;
	disabled?: boolean;
	/** Đánh dấu mục đang được chọn (dùng cho menu sắp xếp). */
	checked?: boolean;
	/** Vạch ngăn cách giữa các nhóm mục. */
	divider?: boolean;
	onSelect: () => void;
}

export interface MenuProps {
	/** Nội dung trigger (nút mở menu). */
	trigger: (props: { open: boolean; toggle: () => void; ref: React.Ref<HTMLButtonElement> }) => ReactNode;
	items: MenuItem[];
	/** Nhãn trợ năng của menu. */
	label: string;
	align?: 'start' | 'end';
}

export function Menu({ trigger, items, label, align = 'end' }: MenuProps) {
	const [open, setOpen] = useState(false);
	const rootRef = useRef<HTMLDivElement>(null);
	const triggerRef = useRef<HTMLButtonElement>(null);
	const menuId = useId();

	useEffect(() => {
		if (!open) return;
		const onPointerDown = (event: MouseEvent) => {
			if (!rootRef.current?.contains(event.target as Node)) setOpen(false);
		};
		const onKeyDown = (event: KeyboardEvent) => {
			if (event.key === 'Escape') {
				setOpen(false);
				triggerRef.current?.focus();
			}
		};
		document.addEventListener('mousedown', onPointerDown);
		document.addEventListener('keydown', onKeyDown);
		return () => {
			document.removeEventListener('mousedown', onPointerDown);
			document.removeEventListener('keydown', onKeyDown);
		};
	}, [open]);

	return (
		<div ref={rootRef} style={{ position: 'relative', display: 'inline-flex' }}>
			{trigger({ open, toggle: () => setOpen((value) => !value), ref: triggerRef })}
			{open ? (
				<div
					className="menu"
					id={menuId}
					role="menu"
					aria-label={label}
					style={align === 'end' ? { top: 'calc(100% + 6px)', right: 0 } : { top: 'calc(100% + 6px)', left: 0 }}
				>
					{items.map((item) =>
						item.divider ? (
							<div key={item.id} className="menu__divider" role="separator" />
						) : (
							<button
								key={item.id}
								type="button"
								role={item.checked ? 'menuitemradio' : 'menuitem'}
								aria-checked={item.checked ? true : undefined}
								className={`menu__item${item.danger ? ' menu__item--danger' : ''}`}
								disabled={item.disabled}
								onClick={() => {
									setOpen(false);
									item.onSelect();
								}}
							>
								{item.icon ? <Icon name={item.icon} /> : null}
								<span>{item.label}</span>
								{item.checked ? <Icon name="check" className="menu__check" /> : null}
							</button>
						),
					)}
				</div>
			) : null}
		</div>
	);
}
