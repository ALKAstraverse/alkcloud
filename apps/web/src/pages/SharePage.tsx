import { useEffect, useState } from 'react';
import { ApiError, API_BASE } from '../lib/api.js';
import { deriveShareVerifier } from '../lib/kdf.js';
import { downloadToFile } from '../lib/download.js';

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

function formatBytes(bytes: number): string {
	if (bytes < 1024) return `${bytes} B`;
	const units = ['KB', 'MB', 'GB', 'TB'];
	let value = bytes / 1024;
	let unit = 0;
	while (value >= 1024 && unit < units.length - 1) {
		value /= 1024;
		unit += 1;
	}
	return `${value.toFixed(1)} ${units[unit]}`;
}

export function SharePage({ token }: SharePageProps) {
	const [info, setInfo] = useState<ShareInfo | null>(null);
	const [password, setPassword] = useState('');
	const [unlocked, setUnlocked] = useState(false);
	// Grant giữ trong bộ nhớ và gửi qua header (cross-site cookie SameSite=Lax
	// không được gửi kèm request từ cloud.alk.xx.kg → api.alk.xx.kg).
	const [grant, setGrant] = useState<string | null>(null);
	const [error, setError] = useState<string | null>(null);
	const [loading, setLoading] = useState(true);

	useEffect(() => {
		if (!token) {
			setError('Thiếu token chia sẻ');
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
		}
	};

	const download = async () => {
		setError(null);
		try {
			const response = await fetch(`${API_BASE}/public/share/download`, {
				headers: { 'x-share-token': token, ...(grant ? { 'x-share-grant': grant } : {}) },
			});
			if (!response.ok) {
				throw new ApiError(response.status, 'download_failed', `Tải thất bại (${response.status})`);
			}
			await downloadToFile(response, info?.fileName ?? 'download');
			// Tải xong: cập nhật lượt tải còn lại (nếu có giới hạn).
			const refreshed = await shareRequest<{ share: ShareInfo }>('/public/share/info', token, {
				headers: grant ? { 'x-share-grant': grant } : {},
			}).catch(() => null);
			if (refreshed) setInfo(refreshed.share);
		} catch (caught) {
			setError(caught instanceof ApiError ? caught.message : 'Tải thất bại');
		}
	};

	if (loading) {
		return (
			<main className="center">
				<p>Đang tải…</p>
			</main>
		);
	}

	return (
		<main className="center">
			<section className="card">
				<h1>Chia sẻ tệp</h1>
				{info ? (
					<>
						<p>
							<strong>{info.fileName ?? 'Tệp được bảo vệ'}</strong>
						</p>
						<p className="muted small">
							{info.size !== null ? formatBytes(info.size) : '—'} · hết hạn {info.expiresAt.slice(0, 10)}
							{info.downloadsRemaining !== null ? ` · còn ${info.downloadsRemaining} lượt tải` : ''}
						</p>
					</>
				) : (
					<p className="muted">Thông tin không khả dụng.</p>
				)}

				{info?.requiresPassword && !unlocked && (
					<form onSubmit={unlock}>
						<label>
							Mật khẩu
							<input
								type="password"
								value={password}
								onChange={(event) => setPassword(event.target.value)}
								required
							/>
						</label>
						<button type="submit">Mở khoá</button>
					</form>
				)}

				{unlocked && (
					<button type="button" onClick={() => void download()}>
						Tải xuống
					</button>
				)}

				{error && <p className="error">{error}</p>}
				<p className="muted small">Chia sẻ tải xuống — không có xem trước.</p>
			</section>
		</main>
	);
}
