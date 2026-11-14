import { FontAwesomeIcon } from '@fortawesome/react-fontawesome';
import type { CSSProperties } from 'react';
import { ICONS, type IconName } from './icons.js';

export type { IconName } from './icons.js';

export interface IconProps {
	name: IconName;
	/** Nhãn trợ năng — bỏ trống với icon trang trí (mặc định aria-hidden). */
	title?: string;
	className?: string;
	style?: CSSProperties;
}

export function Icon({ name, title, className, style }: IconProps) {
	return (
		<FontAwesomeIcon
			icon={ICONS[name]}
			title={title}
			aria-hidden={title ? undefined : true}
			className={className}
			style={style}
		/>
	);
}
