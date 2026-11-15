import { cloneElement, isValidElement, useEffect, useId, useLayoutEffect, useRef, useState, type ReactNode } from 'react';
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
	const [dropUp, setDropUp] = useState(false);
	const rootRef = useRef<HTMLDivElement>(null);
	const menuRef = useRef<HTMLDivElement>(null);
	const triggerElRef = useRef<HTMLButtonElement | null>(null);
	const menuId = useId();

	/** Nút trigger nằm ngay sau phần tử gốc của menu. */
	const getTrigger = () => triggerElRef.current ?? (rootRef.current?.firstElementChild as HTMLElement | null);

	useLayoutEffect(() => {
		if (!open) {
			setDropUp(false);
			return;
		}
		const rect = getTrigger()?.getBoundingClientRect();
		if (!rect) return;
		const estimated = items.length * 40 + 16;
		setDropUp(rect.bottom + estimated > window.innerHeight && rect.top > estimated);
	}, [open, items.length]);

	// Mở menu ⇒ đưa tiêu điểm vào mục đầu tiên (như Google Drive).
	useEffect(() => {
		if (!open) return;
		const first = menuRef.current?.querySelector<HTMLButtonElement>('.menu__item:not([disabled])');
		first?.focus({ preventScroll: true });
	}, [open]);

	useEffect(() => {
		if (!open) return;
		const onPointerDown = (event: MouseEvent) => {
			if (!rootRef.current?.contains(event.target as Node)) setOpen(false);
		};
		const onKeyDown = (event: KeyboardEvent) => {
			if (event.key === 'Escape') {
				setOpen(false);
				getTrigger()?.focus();
			}
		};
		document.addEventListener('mousedown', onPointerDown);
		document.addEventListener('keydown', onKeyDown);
		return () => {
			document.removeEventListener('mousedown', onPointerDown);
			document.removeEventListener('keydown', onKeyDown);
		};
	}, [open]);

	const onMenuKeyDown = (event: React.KeyboardEvent) => {
		const options = Array.from(menuRef.current?.querySelectorAll<HTMLButtonElement>('.menu__item:not([disabled])') ?? []);
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
				setOpen(false);
				break;
			default:
				break;
		}
	};

	const triggerNode = trigger({
		open,
		toggle: () => setOpen((value) => !value),
		ref: (node) => {
			triggerElRef.current = node;
		},
	});
	const triggerElement = isValidElement<Record<string, unknown>>(triggerNode)
		? cloneElement(triggerNode, {
				'aria-haspopup': 'menu',
				'aria-expanded': open,
				...(open ? { 'aria-controls': menuId } : {}),
			})
		: triggerNode;

	return (
		<div ref={rootRef} style={{ position: 'relative', display: 'inline-flex' }}>
			{triggerElement}
			{open ? (
				<div
					ref={menuRef}
					className={dropUp ? 'menu menu--up' : 'menu'}
					id={menuId}
					role="menu"
					aria-label={label}
					onKeyDown={onMenuKeyDown}
					style={
						align === 'end'
							? dropUp
								? { bottom: 'calc(100% + 6px)', right: 0 }
								: { top: 'calc(100% + 6px)', right: 0 }
							: dropUp
								? { bottom: 'calc(100% + 6px)', left: 0 }
								: { top: 'calc(100% + 6px)', left: 0 }
					}
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
