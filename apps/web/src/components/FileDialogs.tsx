import { useEffect, useState } from 'react';
import { Dialog, ConfirmDialog } from './Dialog.js';
import { Button } from './Button.js';
import { Icon } from './Icon.js';
import type { FolderEntry } from '../lib/api.js';
import { formatDateTime } from '../lib/format.js';

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
export function MoveDialog({
	open,
	folders,
	currentFolderId,
	onClose,
	onSubmit,
}: {
	open: boolean;
	folders: FolderEntry[];
	currentFolderId: string | null;
	onClose: () => void;
	onSubmit: (folderId: string | null) => Promise<void>;
}) {
	const [target, setTarget] = useState<string | null>(null);
	const [busy, setBusy] = useState(false);
	const [error, setError] = useState<string | null>(null);

	useEffect(() => {
		if (open) {
			setTarget(currentFolderId);
			setError(null);
			setBusy(false);
		}
	}, [open, currentFolderId]);

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

	return (
		<Dialog
			open={open}
			title="Di chuyển"
			description="Chọn thư mục đích cho mục đang chọn."
			icon="move"
			size="sm"
			onClose={onClose}
		>
			<form onSubmit={submit} style={{ display: 'flex', flexDirection: 'column', gap: 'var(--space-5)' }}>
				<div className="field">
					<label className="field__label" htmlFor="move-target">
						Thư mục đích
					</label>
					<select
						id="move-target"
						className="select"
						value={target ?? ''}
						onChange={(event) => setTarget(event.target.value === '' ? null : event.target.value)}
					>
						<option value="">Thư viện (gốc)</option>
						{folders.map((folder) => (
							<option key={folder.id} value={folder.id}>
								{folder.name}
							</option>
						))}
					</select>
					<span className="field__hint">Chỉ hiển thị các thư mục con trực tiếp của thư mục hiện tại.</span>
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
					.catch(() => setBusy(false));
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
	return (
		<ConfirmDialog
			open={open}
			title="Xoá vĩnh viễn?"
			description={`“${name}” sẽ bị xoá ngay lập tức và không thể khôi phục. Thao tác này không thể hoàn tác.`}
			icon="broom"
			confirmLabel="Xoá vĩnh viễn"
			destructive
			loading={busy}
			onCancel={onClose}
			onConfirm={() => {
				setBusy(true);
				void onConfirm()
					.then(onClose)
					.catch(() => setBusy(false));
			}}
		/>
	);
}
