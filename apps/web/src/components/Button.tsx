import type { ButtonHTMLAttributes, ReactNode, Ref } from 'react';
import { Icon, type IconName } from './Icon.js';

export type ButtonVariant = 'primary' | 'secondary' | 'ghost' | 'soft' | 'danger' | 'danger-ghost';
export type ButtonSize = 'sm' | 'md' | 'lg';

export interface ButtonProps extends ButtonHTMLAttributes<HTMLButtonElement> {
	variant?: ButtonVariant;
	size?: ButtonSize;
	icon?: IconName;
	iconPosition?: 'start' | 'end';
	loading?: boolean;
	block?: boolean;
	children?: ReactNode;
	/** React 19 truyền ref như prop thường — chuyển tiếp xuống <button>. */
	ref?: Ref<HTMLButtonElement>;
}

export function Button({
	variant = 'secondary',
	size = 'md',
	icon,
	iconPosition = 'start',
	loading = false,
	block = false,
	children,
	className = '',
	disabled,
	type = 'button',
	ref,
	...rest
}: ButtonProps) {
	const classes = [
		'btn',
		`btn--${variant}`,
		size !== 'md' ? `btn--${size}` : '',
		block ? 'btn--block' : '',
		className,
	]
		.filter(Boolean)
		.join(' ');

	return (
		<button
			type={type}
			className={classes}
			data-loading={loading ? 'true' : undefined}
			disabled={disabled || loading}
			ref={ref}
			{...rest}
		>
			{icon && iconPosition === 'start' ? <Icon name={icon} /> : null}
			{children}
			{icon && iconPosition === 'end' ? <Icon name={icon} /> : null}
		</button>
	);
}

export interface IconButtonProps extends Omit<ButtonProps, 'children' | 'icon' | 'iconPosition'> {
	icon: IconName;
	/** Bắt buộc: icon-only button phải có nhãn trợ năng. */
	label: string;
}

export function IconButton({ icon, label, variant = 'ghost', size = 'md', className = '', ref, ...rest }: IconButtonProps) {
	const classes = ['btn', `btn--${variant}`, size !== 'md' ? `btn--${size}` : '', 'btn--icon', className]
		.filter(Boolean)
		.join(' ');
	return (
		<button type="button" className={classes} aria-label={label} title={label} ref={ref} {...rest}>
			<Icon name={icon} />
		</button>
	);
}
