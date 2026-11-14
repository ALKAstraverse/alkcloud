import type { ReactNode } from 'react';
import { Icon, type IconName } from './Icon.js';
import { Button } from './Button.js';

export interface EmptyStateProps {
	icon?: IconName;
	title: string;
	description?: string;
	action?: { label: string; onClick: () => void; icon?: IconName };
	secondaryAction?: { label: string; onClick: () => void; icon?: IconName };
}

export function EmptyState({ icon = 'folderOpen', title, description, action, secondaryAction }: EmptyStateProps) {
	return (
		<div className="state">
			<span className="state__icon">
				<Icon name={icon} />
			</span>
			<div>
				<div className="state__title">{title}</div>
				{description ? <p className="state__description">{description}</p> : null}
			</div>
			{action || secondaryAction ? (
				<div className="state__actions">
					{action ? (
						<Button variant="primary" icon={action.icon} onClick={action.onClick}>
							{action.label}
						</Button>
					) : null}
					{secondaryAction ? (
						<Button variant="secondary" icon={secondaryAction.icon} onClick={secondaryAction.onClick}>
							{secondaryAction.label}
						</Button>
					) : null}
				</div>
			) : null}
		</div>
	);
}

export function ErrorState({
	title = 'Không tải được dữ liệu',
	description,
	onRetry,
	retryLabel = 'Thử lại',
}: {
	title?: string;
	description?: string;
	onRetry?: () => void;
	retryLabel?: string;
}) {
	return (
		<div className="state state--error" role="alert">
			<span className="state__icon">
				<Icon name="triangleExclamation" />
			</span>
			<div>
				<div className="state__title">{title}</div>
				{description ? <p className="state__description">{description}</p> : null}
			</div>
			{onRetry ? (
				<div className="state__actions">
					<Button variant="secondary" icon="arrowRotateRight" onClick={onRetry}>
						{retryLabel}
					</Button>
				</div>
			) : null}
		</div>
	);
}

export function Skeleton({ width, height = 14, radius }: { width?: number | string; height?: number; radius?: number }) {
	return (
		<span
			className="skeleton"
			style={{
				display: 'block',
				width: width ?? '100%',
				height,
				borderRadius: radius,
			}}
			aria-hidden="true"
		/>
	);
}

export function SkeletonRows({ rows = 5, height = 44 }: { rows?: number; height?: number }) {
	return (
		<div aria-hidden="true" style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
			{Array.from({ length: rows }, (_, index) => (
				<Skeleton key={index} height={height} radius={10} />
			))}
		</div>
	);
}

export function InlineNotice({
	tone = 'info',
	icon,
	title,
	children,
}: {
	tone?: 'info' | 'warning' | 'danger' | 'success';
	icon?: IconName;
	title?: string;
	children: ReactNode;
}) {
	const fallback: Record<string, IconName> = {
		info: 'circleInfo',
		warning: 'triangleExclamation',
		danger: 'circleXmark',
		success: 'circleCheck',
	};
	return (
		<div
			className={`field__error`}
			style={{
				alignItems: 'flex-start',
				background: `var(--${tone}-soft)`,
				border: `1px solid var(--${tone}-border)`,
				borderRadius: 'var(--radius-md)',
				padding: 'var(--space-4) var(--space-5)',
				color: `var(--${tone})`,
				fontSize: 'var(--text-sm)',
			}}
		>
			<Icon name={icon ?? fallback[tone] ?? 'circleInfo'} style={{ marginTop: 2 }} />
			<div style={{ minWidth: 0 }}>
				{title ? <strong style={{ display: 'block', marginBottom: 2 }}>{title}</strong> : null}
				<div style={{ color: 'var(--text-secondary)' }}>{children}</div>
			</div>
		</div>
	);
}
