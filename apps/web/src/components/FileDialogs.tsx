import { useEffect, useMemo, useState } from 'react';
import { Dialog, ConfirmDialog } from './Dialog.js';
import { Button } from './Button.js';
import { Icon } from './Icon.js';
import type { FolderEntry } from '../lib/api.js';
import { formatDateTime } from '../lib/format.js';
import { shortenPath } from '../lib/path.js';

/* --------------------------------------------------------------- new folder */
export function NewFolderDialog({
	open,
	onClose,
	onSubmit,
}: {
	open: boolean;
	onClose: () => void;
	onSubmit: (name: string) => Promise<void>;
}) {
	const [name, setName] = useState('');
	const [busy, setBusy] = useState(false);
	const [error, setError] = useState<string | null>(null);

	useEffect(() => {
		if (open) {
			setName('');
			setError(null);
			setBusy(false);
		}
	}, [open]);

	const submit = async (event: React.FormEvent) => {
		event.preventDefault();
		const trimmed = name.trim();
		if (!trimmed) {
			setError('Tên thư mục không được để trống');
			return;
		}
		setBusy(true);
		setError(null);
		try {
			await onSubmit(trimmed);
			onClose();
		} catch (caught) {
			setError(caught instanceof Error ? caught.message : 'Không tạo được thư mục');
		} finally {
			setBusy(false);
		}
	};

	return (
		<Dialog
			open={open}
			title="Tạo thư mục mới"
			description="Thư mục giúp gom nhóm tệp theo chủ đề. Có thể đổi tên hoặc di chuyển sau."
			icon="folderPlus"
			size="sm"
			onClose={onClose}
		>
			<form onSubmit={submit} style={{ display: 'flex', flexDirection: 'column', gap: 'var(--space-5)' }}>
				<div className="field">
					<label className="field__label" htmlFor="new-folder-name">
						Tên thư mục
					</label>
					<input
						id="new-folder-name"
						className="input"
						value={name}
						autoFocus
						maxLength={120}
						placeholder="Ví dụ: Hồ sơ 2026"
						onChange={(event) => setName(event.target.value)}
					/>
					{error ? (
						<span className="field__error" role="alert">
							<Icon name="circleExclamation" />
							{error}
						</span>
					) : null}
				</div>
				<div style={{ display: 'flex', justifyContent: 'flex-end', gap: 'var(--space-4)' }}>
					<Button variant="secondary" onClick={onClose} disabled={busy}>
						Huỷ
					</Button>
					<Button variant="primary" type="submit" loading={busy} icon="folderPlus">
						Tạo thư mục
					</Button>
				</div>
			</form>
		</Dialog>
	);
}

/* ------------------------------------------------------------------ rename */
export function RenameDialog({
	open,
	currentName,
	onClose,
	onSubmit,
}: {
	open: boolean;
	currentName: string;
	onClose: () => void;
	onSubmit: (name: string) => Promise<void>;
}) {
	const [name, setName] = useState(currentName);
	const [busy, setBusy] = useState(false);
	const [error, setError] = useState<string | null>(null);

	useEffect(() => {
		if (open) {
			setName(currentName);
			setError(null);
			setBusy(false);
		}
	}, [open, currentName]);

	const submit = async (event: React.FormEvent) => {
		event.preventDefault();
		const trimmed = name.trim();
		if (!trimmed) {
			setError('Tên không được để trống');
			return;
		}
		setBusy(true);
		setError(null);
		try {
			await onSubmit(trimmed);
			onClose();
		} catch (caught) {
			setError(caught instanceof Error ? caught.message : 'Không đổi được tên');
		} finally {
			setBusy(false);
		}
	};

	return (
		<Dialog
			open={open}
			title="Đổi tên"
			description="Tên hiển thị trong thư viện. Tệp đã tải lên không bị ảnh hưởng."
			icon="pen"
			size="sm"
			onClose={onClose}
		>
			<form onSubmit={submit} style={{ display: 'flex', flexDirection: 'column', gap: 'var(--space-5)' }}>
				<div className="field">
					<label className="field__label" htmlFor="rename-input">
						Tên mới
					</label>
					<input
						id="rename-input"
						className="input"
						value={name}
						autoFocus
						maxLength={200}
						onChange={(event) => setName(event.target.value)}
					/>
					{error ? (
						<span className="field__error" role="alert">
							<Icon name="circleExclamation" />
							{error}
						</span>
					) : null}
				</div>
				<div style={{ display: 'flex', justifyContent: 'flex-end', gap: 'var(--space-4)' }}>
					<Button variant="secondary" onClick={onClose} disabled={busy}>
						Huỷ
					</Button>
					<Button variant="primary" type="submit" loading={busy} icon="pen">
						Lưu tên
					</Button>
				</div>
			</form>
		</Dialog>
	);
}

/* -------------------------------------------------------------------- move */
export interface MoveTreeNode {
	id: string;
	name: string;
	parentId: string | null;
	depth: number;
}

/**
 * Hộp thoại "Di chuyển" kiểu Windows:
 *   - cây thư mục (thụt lề theo cấp) — **không có ô tickbox**, click là chọn;
 *   - thanh đường dẫn rút gọn ("…/to/folder") ở trên;
 *   - không cho chọn chính thư mục đang di chuyển hoặc thư mục con của nó.
 */
export function MoveDialog({
	open,
	tree,
	currentFolderId,
	excludeFolderId,
	onClose,
	onSubmit,
}: {
	open: boolean;
	tree: MoveTreeNode[];
	currentFolderId: string | null;
	/** Thư mục đang di chuyển (loại trừ khỏi cây + mọi nhánh con). */
	excludeFolderId?: string | null;
	onClose: () => void;
	onSubmit: (folderId: string | null) => Promise<void>;
}) {
	const [target, setTarget] = useState<string | null>(null);
	const [busy, setBusy] = useState(false);
	const [error, setError] = useState<string | null>(null);
	const [collapsed, setCollapsed] = useState<Set<string>>(new Set());

	const byId = useMemo(() => new Map(tree.map((node) => [node.id, node])), [tree]);

	// Nhánh không được chọn: thư mục đang di chuyển + toàn bộ con cháu của nó.
	const excluded = useMemo(() => {
		const blocked = new Set<string>();
		if (!excludeFolderId) return blocked;
		blocked.add(excludeFolderId);
		let changed = true;
		while (changed) {
			changed = false;
			for (const node of tree) {
				if (node.parentId && blocked.has(node.parentId) && !blocked.has(node.id)) {
					blocked.add(node.id);
					changed = true;
				}
			}
		}
		return blocked;
	}, [tree, excludeFolderId]);

	// Node nào đang hiện: ẩn con của các node đã thu gọn.
	const visible = useMemo(() => {
		const hidden = new Set<string>();
		for (const node of tree) {
			if (!collapsed.has(node.id)) continue;
			for (const child of tree) {
				if (child.parentId === node.id) hidden.add(child.id);
			}
		}
		let changed = true;
		while (changed) {
			changed = false;
			for (const node of tree) {
				if (node.parentId && hidden.has(node.parentId) && !hidden.has(node.id)) {
					hidden.add(node.id);
					changed = true;
				}
			}
		}
		return tree.filter((node) => !hidden.has(node.id));
	}, [tree, collapsed]);

	const hasChildren = useMemo(() => {
		const ids = new Set(tree.map((node) => node.parentId));
		return new Set([...ids].filter((id): id is string => Boolean(id)));
	}, [tree]);

	useEffect(() => {
		if (open) {
			// Mặc định = thư mục đang xem; không chọn trùng vị trí hiện tại của mục.
			setTarget(currentFolderId);
			setError(null);
			setBusy(false);
			setCollapsed(new Set());
		}
	}, [open, currentFolderId]);

	const targetPath = useMemo(() => {
		if (target === null) return '/';
		const segments: string[] = [];
		let current = byId.get(target);
		const guard = new Set<string>();
		while (current && !guard.has(current.id)) {
			guard.add(current.id);
			segments.unshift(current.name);
			current = current.parentId ? byId.get(current.parentId) : undefined;
		}
		return segments.length === 0 ? '/' : `/${segments.join('/')}`;
	}, [target, byId]);

	const submit = async (event: React.FormEvent) => {
		event.preventDefault();
		setBusy(true);
		setError(null);
		try {
			await onSubmit(target);
			onClose();
		} catch (caught) {
			setError(caught instanceof Error ? caught.message : 'Không di chuyển được');
		} finally {
			setBusy(false);
		}
	};

	const toggle = (id: string) => {
		setCollapsed((current) => {
			const next = new Set(current);
			if (next.has(id)) next.delete(id);
			else next.add(id);
			return next;
		});
	};

	return (
		<Dialog
			open={open}
			title="Di chuyển"
			description="Chọn thư mục đích cho mục đang chọn."
			icon="move"
			size="sm"
			onClose={onClose}
		>
			<form onSubmit={submit} style={{ display: 'flex', flexDirection: 'column', gap: 'var(--space-4)' }}>
				<div className="move-path" title={targetPath}>
					<span className="move-path__label">Đích:</span>
					<span className="move-path__value">{shortenPath(targetPath, 42)}</span>
				</div>
				<div className="move-tree" role="tree" aria-label="Cây thư mục">
					<button
						type="button"
						role="treeitem"
						className="move-tree__row"
						data-selected={target === null}
						onClick={() => setTarget(null)}
					>
						<span className="move-tree__spacer" aria-hidden="true" />
						<Icon name="hardDrive" />
						<span className="move-tree__name">Thư viện (gốc)</span>
					</button>
					{visible.map((node) => {
						const blocked = excluded.has(node.id);
						const isSelected = target === node.id;
						const hasChild = hasChildren.has(node.id);
						const isCollapsed = collapsed.has(node.id);
						return (
							<div key={node.id} className="move-tree__row-wrap">
								<button
									type="button"
									role="treeitem"
									className="move-tree__row"
									data-selected={isSelected}
									data-blocked={blocked}
									aria-selected={isSelected}
									disabled={blocked}
									style={{ paddingLeft: `calc(var(--space-4) + ${node.depth} * var(--space-4))` }}
									onClick={() => setTarget(node.id)}
								>
									<span
										role="button"
										tabIndex={-1}
										aria-label={isCollapsed ? 'Mở rộng' : 'Thu gọn'}
										className="move-tree__toggle"
										onClick={(event) => {
											event.stopPropagation();
											if (hasChild) toggle(node.id);
										}}
									>
										{hasChild ? <Icon name={isCollapsed ? 'chevronRight' : 'chevronDown'} /> : null}
									</span>
									<Icon name="folder" />
									<span className="move-tree__name">{node.name}</span>
								</button>
							</div>
						);
					})}
				</div>
				{error ? (
					<span className="field__error" role="alert">
						<Icon name="circleExclamation" />
						{error}
					</span>
				) : null}
				<div style={{ display: 'flex', justifyContent: 'flex-end', gap: 'var(--space-4)' }}>
					<Button variant="secondary" onClick={onClose} disabled={busy}>
						Huỷ
					</Button>
					<Button variant="primary" type="submit" loading={busy} icon="move">
						Di chuyển
					</Button>
				</div>
			</form>
		</Dialog>
	);
}

/* ------------------------------------------------------------------- share */
export interface ShareResult {
	url: string;
	hasPassword: boolean;
	expiresAt: string;
}

export function ShareDialog({
	open,
	onClose,
	onSubmit,
}: {
	open: boolean;
	onClose: () => void;
	onSubmit: (input: { password: string | null; expiresInDays: number }) => Promise<ShareResult>;
}) {
	const [password, setPassword] = useState('');
	const [usePassword, setUsePassword] = useState(false);
	const [expiresInDays, setExpiresInDays] = useState(7);
	const [busy, setBusy] = useState(false);
	const [error, setError] = useState<string | null>(null);
	const [result, setResult] = useState<ShareResult | null>(null);
	const [copied, setCopied] = useState(false);

	useEffect(() => {
		if (open) {
			setPassword('');
			setUsePassword(false);
			setExpiresInDays(7);
			setError(null);
			setResult(null);
			setCopied(false);
			setBusy(false);
		}
	}, [open]);

	const submit = async (event: React.FormEvent) => {
		event.preventDefault();
		if (usePassword && password.length < 8) {
			setError('Mật khẩu chia sẻ phải có ít nhất 8 ký tự');
			return;
		}
		setBusy(true);
		setError(null);
		try {
			const created = await onSubmit({
				password: usePassword ? password : null,
				expiresInDays,
			});
			setResult(created);
		} catch (caught) {
			setError(caught instanceof Error ? caught.message : 'Không tạo được link chia sẻ');
		} finally {
			setBusy(false);
		}
	};

	const copy = async () => {
		if (!result) return;
		try {
			await navigator.clipboard.writeText(result.url);
			setCopied(true);
			window.setTimeout(() => setCopied(false), 2000);
		} catch {
			setError('Trình duyệt chặn sao chép — hãy chọn và copy thủ công');
		}
	};

	return (
		<Dialog
			open={open}
			title="Chia sẻ tệp"
			description="Tạo link tải xuống. Ai có link đều tải được, trừ khi bạn đặt mật khẩu."
			icon="shareNodes"
			onClose={onClose}
			footer={
				result ? (
					<>
						<Button variant="secondary" onClick={onClose}>
							Đóng
						</Button>
						<Button variant="primary" icon={copied ? 'check' : 'copy'} onClick={() => void copy()}>
							{copied ? 'Đã sao chép' : 'Sao chép link'}
						</Button>
					</>
				) : (
					<>
						<Button variant="secondary" onClick={onClose} disabled={busy}>
							Huỷ
						</Button>
						<Button variant="primary" type="submit" form="share-form" loading={busy} icon="shareNodes">
							Tạo link chia sẻ
						</Button>
					</>
				)
			}
		>
			{result ? (
				<div style={{ display: 'flex', flexDirection: 'column', gap: 'var(--space-5)' }}>
					<div className="inline-code" style={{ padding: 'var(--space-4)', wordBreak: 'break-all' }}>
						{result.url}
					</div>
					<div className="share__meta" style={{ justifyContent: 'flex-start' }}>
						<span className="share__meta-item">
							<Icon name="clock" /> Hết hạn {formatDateTime(result.expiresAt)}
						</span>
						{result.hasPassword ? (
							<span className="share__meta-item">
								<Icon name="lock" /> Có mật khẩu
							</span>
						) : null}
					</div>
					{result.hasPassword ? (
						<p className="share__note">
							Chia sẻ mật khẩu với người nhận qua kênh riêng — AlkCloud không gửi email và không lưu mật
							khẩu dạng rõ.
						</p>
					) : null}
				</div>
			) : (
				<form
					id="share-form"
					onSubmit={submit}
					style={{ display: 'flex', flexDirection: 'column', gap: 'var(--space-5)' }}
				>
					<div className="field">
						<label className="field__label" htmlFor="share-expiry">
							Link hết hạn sau
						</label>
						<select
							id="share-expiry"
							className="select"
							value={expiresInDays}
							onChange={(event) => setExpiresInDays(Number(event.target.value))}
						>
							<option value={1}>1 ngày</option>
							<option value={7}>7 ngày</option>
							<option value={30}>30 ngày</option>
							<option value={90}>90 ngày</option>
						</select>
					</div>
					<label className="checkbox">
						<input
							type="checkbox"
							checked={usePassword}
							onChange={(event) => setUsePassword(event.target.checked)}
						/>
						Bảo vệ bằng mật khẩu
					</label>
					{usePassword ? (
						<div className="field">
							<label className="field__label" htmlFor="share-password">
								Mật khẩu chia sẻ
							</label>
							<input
								id="share-password"
								className="input"
								type="password"
								autoComplete="new-password"
								value={password}
								minLength={8}
								placeholder="Tối thiểu 8 ký tự"
								onChange={(event) => setPassword(event.target.value)}
							/>
							<span className="field__hint">
								Mật khẩu được băm trong trình duyệt trước khi gửi lên máy chủ.
							</span>
						</div>
					) : null}
					{error ? (
						<span className="field__error" role="alert">
							<Icon name="circleExclamation" />
							{error}
						</span>
					) : null}
				</form>
			)}
		</Dialog>
	);
}

/* --------------------------------------------------------------- confirmations */
export function DeleteConfirmDialog({
	open,
	names,
	onClose,
	onConfirm,
}: {
	open: boolean;
	names: string[];
	onClose: () => void;
	onConfirm: () => Promise<void>;
}) {
	const [busy, setBusy] = useState(false);
	const single = names.length === 1;
	// Component KHÔNG bị unmount khi đóng (parent chỉ đổi `open`) ⇒ phải reset
	// `busy` mỗi lần mở lại, nếu không nút xác nhận kẹt ở trạng thái loading
	// vĩnh viễn sau lần xoá đầu tiên ⇒ không xoá/purge được nữa.
	useEffect(() => {
		if (open) setBusy(false);
	}, [open]);
	return (
		<ConfirmDialog
			open={open}
			title={single ? 'Chuyển tệp vào thùng rác?' : `Chuyển ${names.length} mục vào thùng rác?`}
			description={
				single
					? `“${names[0]}” sẽ được giữ trong thùng rác và tự xoá vĩnh viễn sau 30 ngày. Bạn có thể khôi phục trước thời hạn.`
					: 'Các mục đã chọn sẽ được giữ trong thùng rác và tự xoá vĩnh viễn sau 30 ngày.'
			}
			icon="trashCan"
			confirmLabel="Chuyển vào thùng rác"
			destructive
			loading={busy}
			onCancel={onClose}
			onConfirm={() => {
				setBusy(true);
				void onConfirm()
					.then(onClose)
					.catch(() => setBusy(false))
					.finally(() => setBusy(false));
			}}
		/>
	);
}

export function PurgeConfirmDialog({
	open,
	name,
	onClose,
	onConfirm,
}: {
	open: boolean;
	name: string;
	onClose: () => void;
	onConfirm: () => Promise<void>;
}) {
	const [busy, setBusy] = useState(false);
	// Xem `DeleteConfirmDialog`: reset `busy` khi mở lại dialog.
	useEffect(() => {
		if (open) setBusy(false);
	}, [open]);
	return (
		<ConfirmDialog
			open={open}
			title="Xoá vĩnh viễn?"
			description={`“${name}” sẽ bị xoá ngay lập tức và không thể khôi phục. Các link chia sẻ của tệp này cũng sẽ bị thu hồi. Thao tác này không thể hoàn tác.`}
			icon="broom"
			confirmLabel="Xoá vĩnh viễn"
			destructive
			loading={busy}
			onCancel={onClose}
			onConfirm={() => {
				setBusy(true);
				void onConfirm()
					.then(onClose)
					.catch(() => setBusy(false))
					.finally(() => setBusy(false));
			}}
		/>
	);
}
