import { useEffect, useState } from 'react';
import { ApiError, API_BASE } from '../lib/api.js';
import { deriveShareVerifier } from '../lib/kdf.js';
import { downloadToFile } from '../lib/download.js';
import { Button } from '../components/Button.js';
import { Icon } from '../components/Icon.js';
import { InlineNotice } from '../components/States.js';
import { formatBytes, formatDate } from '../lib/format.js';
import { useTheme } from '../lib/theme.js';
import { fileKind } from '../lib/file-type.js';

interface SharePageProps {
	token: string;
}

interface ShareInfo {
	/** null khi share có mật khẩu và chưa unlock (chống lộ metadata). */
	fileName: string | null;
	size: number | null;
	contentType: string | null;
	requiresPassword: boolean;
	/** Server xác nhận cookie grant còn hiệu lực. */
	unlocked: boolean;
	expiresAt: string;
	maxDownloads: number | null;
	downloadCount: number;
	downloadsRemaining: number | null;
}

async function shareRequest<T>(path: string, token: string, init: RequestInit = {}): Promise<T> {
	const response = await fetch(`${API_BASE}${path}`, {
		...init,
		headers: {
			'x-share-token': token,
			...(init.body ? { 'content-type': 'application/json' } : {}),
			...(init.headers ?? {}),
		},
	});
	if (!response.ok) {
		const body = (await response.json().catch(() => ({}))) as {
			error?: { message?: string };
		};
		throw new ApiError(response.status, 'share_error', body.error?.message ?? `HTTP ${response.status}`);
	}
	return (await response.json()) as T;
}

export function SharePage({ token }: SharePageProps) {
	useTheme();
	const [info, setInfo] = useState<ShareInfo | null>(null);
	const [password, setPassword] = useState('');
	const [unlocked, setUnlocked] = useState(false);
	// Grant giữ trong bộ nhớ và gửi qua header (cross-site cookie SameSite=Lax
	// không được gửi kèm request từ cloud.alk.xx.kg → api.alk.xx.kg).
	const [grant, setGrant] = useState<string | null>(null);
	const [error, setError] = useState<string | null>(null);
	const [loading, setLoading] = useState(true);
	const [unlocking, setUnlocking] = useState(false);
	const [downloading, setDownloading] = useState(false);

	useEffect(() => {
		if (!token) {
			setError('Thiếu token chia sẻ — đường dẫn có thể bị cắt khi sao chép.');
			setLoading(false);
			return;
		}
		let cancelled = false;
		void (async () => {
			try {
				const result = await shareRequest<{ share: ShareInfo }>('/public/share/info', token);
				if (!cancelled) {
					setInfo(result.share);
					setUnlocked(result.share.unlocked || !result.share.requiresPassword);
				}
			} catch (caught) {
				if (!cancelled) {
					setError(caught instanceof ApiError ? caught.message : 'Không tải được thông tin chia sẻ');
				}
			} finally {
				if (!cancelled) setLoading(false);
			}
		})();
		return () => {
			cancelled = true;
		};
	}, [token]);

	const unlock = async (event: React.FormEvent) => {
		event.preventDefault();
		setError(null);
		setUnlocking(true);
		try {
			const verifier = await deriveShareVerifier(password);
			const result = await shareRequest<{ share: ShareInfo; grant: string }>('/public/share/unlock', token, {
				method: 'POST',
				body: JSON.stringify({ passwordVerifier: verifier }),
			});
			setGrant(result.grant);
			// Sau khi mở khoá, tải lại info để nhận metadata (server chỉ trả sau khi unlock).
			const refreshed = await shareRequest<{ share: ShareInfo }>('/public/share/info', token, {
				headers: { 'x-share-grant': result.grant },
			});
			setInfo(refreshed.share);
			setUnlocked(true);
		} catch (caught) {
			setError(caught instanceof ApiError ? caught.message : 'Mật khẩu không đúng');
		} finally {
			setUnlocking(false);
		}
	};

	const download = async () => {
		setError(null);
		setDownloading(true);
		try {
			// API chỉ ký URL (JSON nhỏ, token vẫn nằm trong header); byte file
			// được fetch trực tiếp từ B2 — không đi qua Worker.
			const target = await shareRequest<{ url: string; fileName: string }>(
				'/public/share/download-url',
				token,
				{ headers: grant ? { 'x-share-grant': grant } : {} },
			);
			const response = await fetch(target.url);
			if (!response.ok) {
				throw new ApiError(response.status, 'download_failed', `Tải thất bại (${response.status})`);
			}
			await downloadToFile(response, info?.fileName ?? target.fileName ?? 'download');
			// Tải xong: cập nhật lượt tải còn lại (nếu có giới hạn).
			const refreshed = await shareRequest<{ share: ShareInfo }>('/public/share/info', token, {
				headers: grant ? { 'x-share-grant': grant } : {},
			}).catch(() => null);
			if (refreshed) setInfo(refreshed.share);
		} catch (caught) {
			setError(caught instanceof ApiError ? caught.message : 'Tải thất bại');
		} finally {
			setDownloading(false);
		}
	};

	const kind = info?.fileName ? fileKind(info.fileName, info.contentType) : null;

	return (
		<div className="share">
			<header className="share__header">
				<div className="brand" style={{ padding: 0 }}>
					<span className="brand__mark">
						<Icon name="cloud" />
					</span>
					<span>
						<span className="brand__name">AlkCloud</span>
						<span className="brand__tagline" style={{ display: 'block' }}>
							Chia sẻ tệp
						</span>
					</span>
				</div>
			</header>

			<main className="share__main">
				{loading ? (
					<section className="share__card" aria-busy="true">
						<span className="share__icon">
							<Icon name="cloud" />
						</span>
						<div className="share__title">Đang mở liên kết…</div>
						<p className="share__note">Đang kiểm tra hiệu lực của liên kết chia sẻ.</p>
					</section>
				) : !info ? (
					<section className="share__card" role="alert">
						<span className="share__icon" style={{ background: 'var(--danger-soft)', color: 'var(--danger)' }}>
							<Icon name="circleXmark" />
						</span>
						<h1 className="share__title">Không mở được liên kết</h1>
						<p className="share__note">
							{error ?? 'Liên kết không tồn tại, đã hết hạn hoặc đã bị thu hồi.'} Hãy liên hệ người gửi để xin
							liên kết mới.
						</p>
					</section>
				) : (
					<section className="share__card">
						<span className="share__icon">
							<Icon name={kind?.icon ?? 'lock'} />
						</span>
						<div>
							<h1 className="share__title">{info.fileName ?? 'Tệp được bảo vệ'}</h1>
							<p className="share__meta" style={{ marginTop: 'var(--space-4)' }}>
								<span className="share__meta-item">
									<Icon name="hardDrive" />
									{info.size !== null ? formatBytes(info.size) : 'Chưa mở khoá'}
								</span>
								<span className="share__meta-item">
									<Icon name="clock" /> Hết hạn {formatDate(info.expiresAt)}
								</span>
								{info.downloadsRemaining !== null ? (
									<span className="share__meta-item">
										<Icon name="download" /> Còn {info.downloadsRemaining} lượt tải
									</span>
								) : null}
								{info.requiresPassword ? (
									<span className="share__meta-item">
										<Icon name="lock" /> Có mật khẩu
									</span>
								) : null}
							</p>
						</div>

						{info.requiresPassword && !unlocked ? (
							<form className="share__form" onSubmit={unlock}>
								<div className="field">
									<label className="field__label" htmlFor="share-password">
										Mật khẩu chia sẻ
									</label>
									<input
										id="share-password"
										className="input"
										type="password"
										value={password}
										onChange={(event) => setPassword(event.target.value)}
										required
										autoFocus
										autoComplete="off"
										placeholder="Nhập mật khẩu người gửi đã đưa"
									/>
									<span className="field__hint">
										Mật khẩu được băm ngay trong trình duyệt — AlkCloud không nhận mật khẩu gốc.
									</span>
								</div>
								<Button variant="primary" type="submit" size="lg" block loading={unlocking} icon="lock">
									Mở khoá và xem tệp
								</Button>
							</form>
						) : null}

						{unlocked ? (
							<Button
								variant="primary"
								size="lg"
								block
								icon="download"
								loading={downloading}
								onClick={() => void download()}
							>
								Tải xuống{info.size !== null ? ` · ${formatBytes(info.size)}` : ''}
							</Button>
						) : null}

						{error && info ? (
							<InlineNotice tone="danger" title="Không thực hiện được">
								{error}
							</InlineNotice>
						) : null}

						<p className="share__note">
							Liên kết chỉ để tải xuống — không xem trước, không chỉnh sửa. Người gửi có thể thu hồi bất kỳ lúc
							nào.
						</p>
					</section>
				)}
			</main>
		</div>
	);
}
