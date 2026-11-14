import { useEffect, useState } from 'react';
import { Icon } from './Icon.js';
import { Button, IconButton } from './Button.js';
import { fileKind } from '../lib/file-type.js';
import { formatBytes } from '../lib/format.js';

export type UploadItemStatus = 'queued' | 'uploading' | 'success' | 'error' | 'canceled';

export interface UploadQueueItem {
	id: string;
	name: string;
	size: number;
	uploadedBytes: number;
	status: UploadItemStatus;
	error?: string;
	startedAt?: number;
	finishedAt?: number;
}

export interface UploadPanelProps {
	items: UploadQueueItem[];
	onCancel: (id: string) => void;
	onRetry: (id: string) => void;
	onDismiss: (id: string) => void;
	onClearFinished: () => void;
	onClose: () => void;
}

/** Tốc độ trung bình (byte/giây) — chỉ tính khi đang tải. */
function speedOf(item: UploadQueueItem, now: number): number | null {
	if (item.status !== 'uploading' || !item.startedAt) return null;
	const elapsed = (now - item.startedAt) / 1000;
	if (elapsed <= 0.5 || item.uploadedBytes <= 0) return null;
	return item.uploadedBytes / elapsed;
}

export function UploadPanel({ items, onCancel, onRetry, onDismiss, onClearFinished, onClose }: UploadPanelProps) {
	const finished = items.filter((item) => item.status === 'success' || item.status === 'error' || item.status === 'canceled');
	const active = items.length - finished.length;
	const failed = items.filter((item) => item.status === 'error').length;
	// Nhịp 1s để tốc độ tải không bị "đứng" giữa hai lần báo tiến độ.
	const [tick, setTick] = useState(() => Date.now());
	useEffect(() => {
		if (!items.some((item) => item.status === 'uploading')) return;
		const timer = window.setInterval(() => setTick(Date.now()), 1000);
		return () => window.clearInterval(timer);
	}, [items]);

	if (items.length === 0) return null;

	return (
		<aside className="upload-panel" aria-label="Hàng đợi tải lên">
			<div className="upload-panel__head">
				<Icon name="cloudArrowUp" style={{ width: 16, height: 16, color: 'var(--accent)' }} />
				<span className="upload-panel__title">
					{active > 0 ? `Đang tải lên ${active} tệp` : 'Tải lên hoàn tất'}
				</span>
				{failed > 0 ? <span className="badge badge--danger">{failed} lỗi</span> : null}
				{finished.length > 0 ? (
					<Button variant="ghost" size="sm" onClick={onClearFinished}>
						Dọn
					</Button>
				) : null}
				<IconButton icon="xmark" label="Đóng hàng đợi tải lên" size="sm" onClick={onClose} />
			</div>
			<div className="upload-panel__list">
				{items.map((item) => {
					const kind = fileKind(item.name);
					const percent = item.size > 0 ? Math.min(100, Math.round((item.uploadedBytes / item.size) * 100)) : 0;
					const speed = speedOf(item, tick);
					return (
						<div className="upload-item" key={item.id}>
							<span className={`upload-item__icon ${kind.tone}`}>
								<Icon name={kind.icon} />
							</span>
							<div className="upload-item__body">
								<div className="upload-item__name truncate" title={item.name}>
									{item.name}
								</div>
								<div className="upload-item__meta">
									<span>{formatBytes(item.size)}</span>
									{item.status === 'uploading' ? <span>· {percent}%</span> : null}
									{speed ? <span>· {formatBytes(Math.round(speed))}/s</span> : null}
									{item.status === 'success' ? (
										<span className="upload-item__status upload-item__status--success">Hoàn tất</span>
									) : null}
									{item.status === 'error' ? (
										<span className="upload-item__status upload-item__status--error" title={item.error}>
											Thất bại
										</span>
									) : null}
									{item.status === 'canceled' ? (
										<span className="upload-item__status">Đã huỷ</span>
									) : null}
									{item.status === 'queued' ? <span>Đang chờ</span> : null}
								</div>
								{item.status === 'uploading' || item.status === 'success' ? (
									<div className={`progress${item.status === 'success' ? ' progress--success' : ''}`}>
										<div className="progress__bar" style={{ width: `${percent}%` }} />
									</div>
								) : null}
								{item.status === 'error' && item.error ? (
									<div className="small" style={{ color: 'var(--danger)' }}>
										{item.error}
									</div>
								) : null}
							</div>
							{item.status === 'uploading' || item.status === 'queued' ? (
								<IconButton
									icon="xmark"
									label={`Huỷ tải lên ${item.name}`}
									size="sm"
									onClick={() => onCancel(item.id)}
								/>
							) : null}
							{item.status === 'error' ? (
								<IconButton
									icon="arrowRotateRight"
									label={`Thử lại ${item.name}`}
									size="sm"
									onClick={() => onRetry(item.id)}
								/>
							) : null}
							{item.status === 'success' || item.status === 'canceled' ? (
								<IconButton
									icon="xmark"
									label={`Bỏ ${item.name} khỏi danh sách`}
									size="sm"
									onClick={() => onDismiss(item.id)}
								/>
							) : null}
						</div>
					);
				})}
			</div>
		</aside>
	);
}
