import { useCallback, useEffect, useId, useRef, type ReactNode } from 'react';
import { Icon, type IconName } from './Icon.js';
import { Button } from './Button.js';

export interface DialogProps {
	open: boolean;
	title: string;
	description?: string;
	icon?: IconName;
	iconTone?: 'accent' | 'danger' | 'warning';
	size?: 'sm' | 'md' | 'lg';
	children?: ReactNode;
	footer?: ReactNode;
	onClose: () => void;
	/** Đóng khi bấm ra ngoài (mặc định: có). */
	closeOnBackdrop?: boolean;
	/** Đóng khi nhấn ESC (mặc định: có). */
	closeOnEscape?: boolean;
}

const FOCUSABLE =
	'a[href], button:not([disabled]), textarea:not([disabled]), input:not([disabled]), select:not([disabled]), [tabindex]:not([tabindex="-1"])';

export function Dialog({
	open,
	title,
	description,
	icon,
	iconTone = 'accent',
	size = 'md',
	children,
	footer,
	onClose,
	closeOnBackdrop = true,
	closeOnEscape = true,
}: DialogProps) {
	const panelRef = useRef<HTMLDivElement>(null);
	const previouslyFocused = useRef<HTMLElement | null>(null);
	const titleId = useId();
	const descriptionId = useId();

	const handleKeyDown = useCallback(
		(event: KeyboardEvent) => {
			if (!open) return;
			if (event.key === 'Escape' && closeOnEscape) {
				event.stopPropagation();
				onClose();
				return;
			}
			if (event.key !== 'Tab') return;
			const panel = panelRef.current;
			if (!panel) return;
			const focusable = Array.from(panel.querySelectorAll<HTMLElement>(FOCUSABLE)).filter(
				(element) => element.offsetParent !== null || element === document.activeElement,
			);
			if (focusable.length === 0) {
				event.preventDefault();
				panel.focus();
				return;
			}
			const first = focusable[0]!;
			const last = focusable[focusable.length - 1]!;
			if (event.shiftKey && document.activeElement === first) {
				event.preventDefault();
				last.focus();
			} else if (!event.shiftKey && document.activeElement === last) {
				event.preventDefault();
				first.focus();
			}
		},
		[open, closeOnEscape, onClose],
	);

	useEffect(() => {
		if (!open) return;
		previouslyFocused.current = document.activeElement as HTMLElement | null;
		const { overflow } = document.body.style;
		document.body.style.overflow = 'hidden';
		document.addEventListener('keydown', handleKeyDown, true);
		// Đưa focus vào panel để screen reader đọc tiêu đề ngay.
		const timer = window.setTimeout(() => {
			const panel = panelRef.current;
			if (!panel) return;
			const focusable = panel.querySelector<HTMLElement>(FOCUSABLE);
			(focusable ?? panel).focus();
		}, 0);
		return () => {
			document.removeEventListener('keydown', handleKeyDown, true);
			document.body.style.overflow = overflow;
			window.clearTimeout(timer);
			previouslyFocused.current?.focus?.();
		};
	}, [open, handleKeyDown]);

	if (!open) return null;

	return (
		<div
			className="dialog__backdrop"
			onMouseDown={(event) => {
				if (closeOnBackdrop && event.target === event.currentTarget) onClose();
			}}
		>
			<div
				className={`dialog${size !== 'md' ? ` dialog--${size}` : ''}`}
				role="dialog"
				aria-modal="true"
				aria-labelledby={titleId}
				aria-describedby={description ? descriptionId : undefined}
				ref={panelRef}
				tabIndex={-1}
			>
				<div className="dialog__header">
					{icon ? (
						<span className={`dialog__icon${iconTone !== 'accent' ? ` dialog__icon--${iconTone}` : ''}`}>
							<Icon name={icon} />
						</span>
					) : null}
					<div>
						<h2 className="dialog__title" id={titleId}>
							{title}
						</h2>
						{description ? (
							<p className="dialog__description" id={descriptionId}>
								{description}
							</p>
						) : null}
					</div>
				</div>
				{children ? <div className="dialog__body">{children}</div> : null}
				{footer ? <div className="dialog__footer">{footer}</div> : null}
			</div>
		</div>
	);
}

export interface ConfirmDialogProps {
	open: boolean;
	title: string;
	description?: string;
	icon?: IconName;
	iconTone?: 'accent' | 'danger' | 'warning';
	confirmLabel?: string;
	cancelLabel?: string;
	destructive?: boolean;
	loading?: boolean;
	onConfirm: () => void;
	onCancel: () => void;
	children?: ReactNode;
}

export function ConfirmDialog({
	open,
	title,
	description,
	icon = 'triangleExclamation',
	iconTone = 'danger',
	confirmLabel = 'Xác nhận',
	cancelLabel = 'Huỷ',
	destructive = false,
	loading = false,
	onConfirm,
	onCancel,
	children,
}: ConfirmDialogProps) {
	return (
		<Dialog
			open={open}
			title={title}
			description={description}
			icon={icon}
			iconTone={iconTone}
			size="sm"
			onClose={onCancel}
			footer={
				<>
					<Button variant="secondary" onClick={onCancel} disabled={loading}>
						{cancelLabel}
					</Button>
					<Button
						variant={destructive ? 'danger' : 'primary'}
						onClick={onConfirm}
						loading={loading}
					>
						{confirmLabel}
					</Button>
				</>
			}
		>
			{children}
		</Dialog>
	);
}
