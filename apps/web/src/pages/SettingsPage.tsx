import { useCallback, useEffect, useState } from 'react';
import {
	ApiError,
	changePassword,
	getAuthParams,
	listSessions,
	logout,
	regenerateRecoveryCodes,
	revokeSession,
} from '../lib/api.js';
import { DEFAULT_KDF_PARAMS, deriveAuthKey, parseKdfParams, randomSalt } from '../lib/kdf.js';
import { Button, IconButton } from '../components/Button.js';
import { Icon } from '../components/Icon.js';
import { InlineNotice } from '../components/States.js';
import { useToast } from '../components/Toast.js';
import { useTheme } from '../lib/theme.js';
import { formatBytes, formatDateTime, formatRelative, quotaModeLabel } from '../lib/format.js';

type Section = 'account' | 'security' | 'sessions' | 'appearance';

interface SessionRow {
	id: string;
	createdAt: string;
	lastSeenAt: string;
	expiresAt: string;
	revokedAt: string | null;
	userAgent: string | null;
	current: boolean;
}

type Usage = { quotaBytes: number; usedBytes: number; reservedBytes: number } | null;

export interface SettingsPageProps {
	ownerEmail: string | null;
	usage: Usage;
	mode: string;
	onRefresh: () => void;
}

export function SettingsPage({ ownerEmail, usage, mode, onRefresh }: SettingsPageProps) {
	const [section, setSection] = useState<Section>('account');

	const navItems: { id: Section; label: string; icon: 'user' | 'shieldHalved' | 'key' | 'eye' }[] = [
		{ id: 'account', label: 'Tài khoản', icon: 'user' },
		{ id: 'security', label: 'Bảo mật', icon: 'shieldHalved' },
		{ id: 'sessions', label: 'Phiên đăng nhập', icon: 'key' },
		{ id: 'appearance', label: 'Giao diện', icon: 'eye' },
	];

	return (
		<div className="settings">
			<nav className="settings__nav" aria-label="Mục cài đặt">
				{navItems.map((item) => (
					<button
						key={item.id}
						type="button"
						className="settings__nav-item"
						aria-current={section === item.id ? 'true' : undefined}
						onClick={() => setSection(item.id)}
					>
						<Icon name={item.icon} />
						{item.label}
					</button>
				))}
			</nav>

			<div className="settings__content">
				{section === 'account' ? <AccountSection ownerEmail={ownerEmail} usage={usage} mode={mode} /> : null}
				{section === 'security' ? <SecuritySection onRefresh={onRefresh} /> : null}
				{section === 'sessions' ? <SessionsSection /> : null}
				{section === 'appearance' ? <AppearanceSection /> : null}
				<p className="muted" style={{ fontSize: 'var(--text-xs)', marginTop: 'var(--space-6)' }}>
					Phiên bản web: <span style={{ fontFamily: 'var(--font-mono)' }}>{__BUILD_ID__}</span>
				</p>
			</div>
		</div>
	);
}

/* --------------------------------------------------------------- account */
function AccountSection({ ownerEmail, usage, mode }: { ownerEmail: string | null; usage: Usage; mode: string }) {
	const percent =
		usage && usage.quotaBytes > 0
			? Math.min(100, ((usage.usedBytes + usage.reservedBytes) / usage.quotaBytes) * 100)
			: 0;

	return (
		<>
			<section className="panel">
				<div className="panel__header">
					<span className="panel__title">
						<Icon name="user" />
						Tài khoản
					</span>
				</div>
				<div className="panel__body">
					<div className="setting-row">
						<div className="setting-row__text">
							<div className="setting-row__title">Email chủ tài khoản</div>
							<div className="setting-row__description">Tài khoản AlkCloud trên máy chủ này.</div>
						</div>
						<div className="setting-row__control">
							<span className="inline-code">{ownerEmail ?? '—'}</span>
						</div>
					</div>
					<div className="setting-row">
						<div className="setting-row__text">
							<div className="setting-row__title">Trạng thái dung lượng</div>
							<div className="setting-row__description">
								Chế độ hiện tại: <strong>{quotaModeLabel(mode)}</strong>
								{mode !== 'NORMAL' ? ' — một số thao tác có thể bị hạn chế.' : ''}
							</div>
						</div>
						<div className="setting-row__control">
							<span className={`badge ${mode === 'NORMAL' ? 'badge--success' : 'badge--warning'}`}>
								{quotaModeLabel(mode)}
							</span>
						</div>
					</div>
				</div>
			</section>

			<section className="panel">
				<div className="panel__header">
					<span className="panel__title">
						<Icon name="hardDrive" />
						Dung lượng lưu trữ
					</span>
				</div>
				<div className="panel__body">
					<div className="storage-meter">
						<div className="storage-meter__legend">
							<span className="storage-meter__value">{usage ? formatBytes(usage.usedBytes) : '—'}</span>
							<span className="storage-meter__hint">
								trên {usage ? formatBytes(usage.quotaBytes) : '—'} · đã dùng {Math.round(percent)}%
							</span>
						</div>
						<div className="progress">
							<div
								className={`progress__bar${percent > 90 ? ' progress--danger' : percent > 75 ? ' progress--warning' : ''}`}
								style={{ width: `${percent}%` }}
							/>
						</div>
						{usage && usage.reservedBytes > 0 ? (
							<p className="storage-meter__hint">
								Đang giữ chỗ tạm thời {formatBytes(usage.reservedBytes)} cho các upload chưa hoàn tất — phần này
								sẽ tự giải phóng.
							</p>
						) : null}
						<p className="storage-meter__hint">
							Dung lượng thực tế bị trừ khi tệp tải lên hoàn tất. Tệp trong thùng rác vẫn chiếm chỗ cho tới khi bị
							xoá vĩnh viễn.
						</p>
					</div>
				</div>
			</section>
		</>
	);
}

/* -------------------------------------------------------------- security */
function SecuritySection({ onRefresh }: { onRefresh: () => void }) {
	const toast = useToast();
	const [currentPassword, setCurrentPassword] = useState('');
	const [newPassword, setNewPassword] = useState('');
	const [confirmPassword, setConfirmPassword] = useState('');
	const [showPasswords, setShowPasswords] = useState(false);
	const [busy, setBusy] = useState(false);
	const [error, setError] = useState<string | null>(null);
	const [recoveryCodes, setRecoveryCodes] = useState<string[] | null>(null);
	const [regenerating, setRegenerating] = useState(false);

	const submit = async (event: React.FormEvent) => {
		event.preventDefault();
		setError(null);
		if (newPassword.length < 12) {
			setError('Mật khẩu mới phải có ít nhất 12 ký tự');
			return;
		}
		if (newPassword !== confirmPassword) {
			setError('Mật khẩu xác nhận không khớp');
			return;
		}
		setBusy(true);
		try {
			const stored = await getAuthParams();
			const current = await deriveAuthKey(currentPassword, stored.salt, parseKdfParams(stored.params));
			const salt = randomSalt();
			const next = await deriveAuthKey(newPassword, salt, DEFAULT_KDF_PARAMS);
			const result = await changePassword({
				currentAuthKey: current.authKey,
				newAuthKey: next.authKey,
				newAuthVerifierSalt: next.authVerifierSalt,
				newAuthParams: next.authParams,
			});
			setRecoveryCodes(result.recoveryCodes);
			setCurrentPassword('');
			setNewPassword('');
			setConfirmPassword('');
			onRefresh();
			toast.push({
				tone: 'success',
				title: 'Đã đổi mật khẩu',
				message: 'Các phiên khác đã bị đăng xuất. Hãy lưu bộ mã khôi phục mới.',
			});
		} catch (caught) {
			setError(caught instanceof ApiError ? caught.message : 'Không đổi được mật khẩu');
		} finally {
			setBusy(false);
		}
	};

	const regenerate = async () => {
		setRegenerating(true);
		try {
			const result = await regenerateRecoveryCodes();
			setRecoveryCodes(result.recoveryCodes);
			toast.push({ tone: 'success', title: 'Đã tạo bộ mã khôi phục mới', message: 'Mã cũ không còn hiệu lực.' });
		} catch (caught) {
			toast.push({
				tone: 'error',
				title: 'Không tạo được mã khôi phục',
				message: caught instanceof ApiError ? caught.message : undefined,
			});
		} finally {
			setRegenerating(false);
		}
	};

	return (
		<>
			<section className="panel">
				<div className="panel__header">
					<span className="panel__title">
						<Icon name="lock" />
						Đổi mật khẩu
					</span>
				</div>
				<div className="panel__body">
					<p className="settings__section-description" style={{ marginBottom: 'var(--space-6)' }}>
						Mật khẩu được băm PBKDF2 (600 000 vòng) ngay trong trình duyệt — máy chủ chỉ nhận giá trị đã băm và
						không thể đọc mật khẩu gốc.
					</p>
					<form onSubmit={submit} style={{ display: 'flex', flexDirection: 'column', gap: 'var(--space-5)' }}>
						<div className="field">
							<label className="field__label" htmlFor="current-password">
								Mật khẩu hiện tại
							</label>
							<input
								id="current-password"
								className="input"
								type={showPasswords ? 'text' : 'password'}
								autoComplete="current-password"
								value={currentPassword}
								required
								onChange={(event) => setCurrentPassword(event.target.value)}
							/>
						</div>
						<div className="field">
							<label className="field__label" htmlFor="new-password">
								Mật khẩu mới
							</label>
							<input
								id="new-password"
								className="input"
								type={showPasswords ? 'text' : 'password'}
								autoComplete="new-password"
								minLength={12}
								value={newPassword}
								required
								onChange={(event) => setNewPassword(event.target.value)}
							/>
							<span className="field__hint">Tối thiểu 12 ký tự.</span>
						</div>
						<div className="field">
							<label className="field__label" htmlFor="confirm-password">
								Nhập lại mật khẩu mới
							</label>
							<input
								id="confirm-password"
								className="input"
								type={showPasswords ? 'text' : 'password'}
								autoComplete="new-password"
								value={confirmPassword}
								required
								onChange={(event) => setConfirmPassword(event.target.value)}
							/>
						</div>
						<label className="checkbox">
							<input
								type="checkbox"
								checked={showPasswords}
								onChange={(event) => setShowPasswords(event.target.checked)}
							/>
							Hiện mật khẩu
						</label>
						{error ? (
							<span className="field__error" role="alert">
								<Icon name="circleExclamation" />
								{error}
							</span>
						) : null}
						<div style={{ display: 'flex', justifyContent: 'flex-end', gap: 'var(--space-4)' }}>
							<Button variant="primary" type="submit" loading={busy} icon="lock">
								Đổi mật khẩu
							</Button>
						</div>
					</form>
				</div>
			</section>

			<section className="panel">
				<div className="panel__header">
					<span className="panel__title">
						<Icon name="key" />
						Mã khôi phục
					</span>
				</div>
				<div className="panel__body">
					<div className="setting-row" style={{ borderBottom: 'none', paddingTop: 0 }}>
						<div className="setting-row__text">
							<div className="setting-row__title">Bộ mã dự phòng</div>
							<div className="setting-row__description">
								Dùng khi quên mật khẩu. Mỗi mã chỉ dùng được một lần; tạo bộ mới sẽ vô hiệu hoá toàn bộ mã cũ.
							</div>
						</div>
						<div className="setting-row__control">
							<Button variant="secondary" icon="key" loading={regenerating} onClick={() => void regenerate()}>
								Tạo bộ mã mới
							</Button>
						</div>
					</div>
					{recoveryCodes ? (
						<div
							style={{ marginTop: 'var(--space-5)', display: 'flex', flexDirection: 'column', gap: 'var(--space-4)' }}
						>
							<InlineNotice tone="warning" title="Chỉ hiển thị một lần">
								Lưu các mã này ở nơi an toàn (trình quản lý mật khẩu hoặc bản giấy). Không chia sẻ với ai.
							</InlineNotice>
							<div className="recovery-codes">
								{recoveryCodes.map((code) => (
									<span key={code} className="recovery-codes__item">
										{code}
									</span>
								))}
							</div>
							<div style={{ display: 'flex', justifyContent: 'flex-end', gap: 'var(--space-4)' }}>
								<Button
									variant="secondary"
									icon="copy"
									onClick={() => {
										void navigator.clipboard
											?.writeText(recoveryCodes.join('\n'))
											.then(() => toast.push({ tone: 'success', title: 'Đã sao chép bộ mã' }))
											.catch(() =>
												toast.push({
													tone: 'warning',
													title: 'Không sao chép được',
													message: 'Hãy chọn và copy thủ công.',
												}),
											);
									}}
								>
									Sao chép tất cả
								</Button>
								<Button variant="ghost" onClick={() => setRecoveryCodes(null)}>
									Đã lưu — ẩn đi
								</Button>
							</div>
						</div>
					) : null}
				</div>
			</section>
		</>
	);
}

/* -------------------------------------------------------------- sessions */
function SessionsSection() {
	const toast = useToast();
	const [sessions, setSessions] = useState<SessionRow[] | null>(null);
	const [error, setError] = useState<string | null>(null);
	const [busyId, setBusyId] = useState<string | null>(null);

	const load = useCallback(async () => {
		try {
			const result = await listSessions();
			setSessions(result.sessions);
			setError(null);
		} catch (caught) {
			setError(caught instanceof ApiError ? caught.message : 'Không tải được danh sách phiên');
		}
	}, []);

	useEffect(() => {
		void load();
	}, [load]);

	const revoke = async (row: SessionRow) => {
		setBusyId(row.id);
		try {
			await revokeSession(row.id);
			toast.push({ tone: 'success', title: 'Đã thu hồi phiên đăng nhập' });
			await load();
		} catch (caught) {
			toast.push({
				tone: 'error',
				title: 'Không thu hồi được phiên',
				message: caught instanceof ApiError ? caught.message : undefined,
			});
		} finally {
			setBusyId(null);
		}
	};

	return (
		<section className="panel">
			<div className="panel__header">
				<span className="panel__title">
					<Icon name="key" />
					Phiên đăng nhập
				</span>
				<IconButton icon="arrowRotateRight" label="Tải lại danh sách phiên" size="sm" onClick={() => void load()} />
			</div>
			<div className="panel__body">
				{error ? (
					<InlineNotice tone="danger" title="Lỗi tải dữ liệu">
						{error}
					</InlineNotice>
				) : sessions === null ? (
					<p className="small muted">Đang tải…</p>
				) : sessions.length === 0 ? (
					<p className="small muted">Không có phiên nào.</p>
				) : (
					sessions.map((row) => (
						<div key={row.id} className="setting-row">
							<div className="setting-row__text">
								<div className="setting-row__title">
									{row.current ? 'Thiết bị này' : (row.userAgent ?? 'Thiết bị không rõ')}
									{row.current ? (
										<span className="badge badge--accent" style={{ marginLeft: 8 }}>
											Hiện tại
										</span>
									) : null}
								</div>
								<div className="setting-row__description">
									Hoạt động {formatRelative(row.lastSeenAt)} · hết hạn {formatDateTime(row.expiresAt)}
									{row.revokedAt ? ' · đã thu hồi' : ''}
								</div>
							</div>
							<div className="setting-row__control">
								{row.current ? (
									<Button
										variant="secondary"
										size="sm"
										icon="signOut"
										onClick={() => void logout().then(() => window.location.reload())}
									>
										Đăng xuất
									</Button>
								) : (
									<Button
										variant="danger-ghost"
										size="sm"
										icon="xmark"
										disabled={Boolean(row.revokedAt)}
										loading={busyId === row.id}
										onClick={() => void revoke(row)}
									>
										Thu hồi
									</Button>
								)}
							</div>
						</div>
					))
				)}
			</div>
		</section>
	);
}

/* ------------------------------------------------------------ appearance */
function AppearanceSection() {
	const { theme, setTheme } = useTheme();
	return (
		<section className="panel">
			<div className="panel__header">
				<span className="panel__title">
					<Icon name="eye" />
					Giao diện
				</span>
			</div>
			<div className="panel__body">
				<div className="setting-row">
					<div className="setting-row__text">
						<div className="setting-row__title">Chế độ hiển thị</div>
						<div className="setting-row__description">
							Theo mặc định AlkCloud dùng nền sáng. Chế độ tối giảm mỏi mắt khi làm việc ban đêm.
						</div>
					</div>
					<div className="setting-row__control">
						<div className="segmented" role="group" aria-label="Chế độ hiển thị">
							<button
								type="button"
								className="segmented__option"
								aria-pressed={theme === 'light'}
								onClick={() => setTheme('light')}
							>
								<Icon name="sun" />
								Sáng
							</button>
							<button
								type="button"
								className="segmented__option"
								aria-pressed={theme === 'dark'}
								onClick={() => setTheme('dark')}
							>
								<Icon name="moon" />
								Tối
							</button>
						</div>
					</div>
				</div>
				<div className="setting-row">
					<div className="setting-row__text">
						<div className="setting-row__title">Kiểu hiển thị tệp</div>
						<div className="setting-row__description">
							Chọn lưới hoặc danh sách ở thanh công cụ trang Tệp — lựa chọn được ghi nhớ cho lần sau.
						</div>
					</div>
				</div>
				<p className="settings__section-description">
					AlkCloud tôn trọng thiết lập giảm chuyển động của hệ điều hành: hiệu ứng sẽ tự tắt khi bật “Reduce
					motion”.
				</p>
			</div>
		</section>
	);
}
