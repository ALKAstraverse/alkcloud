import { useEffect, useState } from 'react';
import { getAuthStatus, getSession, setCsrfToken } from './lib/api.js';
import { LoginPage } from './pages/LoginPage.js';
import { FilesPage, type WorkspaceView } from './pages/FilesPage.js';
import { SharePage } from './pages/SharePage.js';
import { ToastProvider } from './components/Toast.js';
import { Icon } from './components/Icon.js';

export type Route =
	| { kind: 'login' }
	| { kind: 'files'; view: WorkspaceView }
	| { kind: 'share'; token: string };

const VIEWS: WorkspaceView[] = ['files', 'trash', 'settings'];

export function parseRoute(): Route {
	const path = window.location.pathname.replace(/\/+$/, '') || '/';
	// Share token nằm trong fragment: `#<token>` — không bao giờ gửi lên server.
	if (path === '/s' || path.startsWith('/s/')) {
		const token = window.location.hash.replace(/^#/, '').trim();
		return { kind: 'share', token };
	}
	if (path === '/trash') return { kind: 'files', view: 'trash' };
	if (path === '/settings') return { kind: 'files', view: 'settings' };
	return { kind: 'files', view: 'files' };
}

function pathForView(view: WorkspaceView): string {
	if (view === 'trash') return '/trash';
	if (view === 'settings') return '/settings';
	return '/';
}

export function App() {
	const [route, setRoute] = useState<Route>(() => parseRoute());
	const [bootstrapped, setBootstrapped] = useState<boolean | null>(null);
	const [authenticated, setAuthenticated] = useState(false);
	const [ownerEmail, setOwnerEmail] = useState<string | null>(null);
	const [loading, setLoading] = useState(true);
	const [statusError, setStatusError] = useState<string | null>(null);

	useEffect(() => {
		const onPopState = () => setRoute(parseRoute());
		window.addEventListener('popstate', onPopState);
		return () => window.removeEventListener('popstate', onPopState);
	}, []);

	// Worker redirect `/` → `/app/<version>/` (để né cache edge cũ) ⇒ dọn URL cho gọn.
	useEffect(() => {
		if (window.location.pathname.startsWith('/app/')) {
			const normalized = parseRoute();
			const target = normalized.kind === 'files' ? pathForView(normalized.view) : '/';
			window.history.replaceState(null, '', target);
		}
	}, []);

	useEffect(() => {
		let cancelled = false;
		void (async () => {
			try {
				const status = await getAuthStatus();
				if (cancelled) return;
				setBootstrapped(status.bootstrapped);
				if (status.bootstrapped) {
					try {
						const session = await getSession();
						setCsrfToken(session.session.csrfToken);
						if (!cancelled) {
							setAuthenticated(true);
							setOwnerEmail(session.owner?.email ?? null);
						}
					} catch {
						if (!cancelled) setAuthenticated(false);
					}
				}
			} catch {
				// KHÔNG coi lỗi mạng là "chưa khởi tạo": owner đã tồn tại thì form
				// bootstrap là hướng sai ⇒ owner nhập setup token rồi mới biết
				// là tài khoản đã tồn tại. Phải báo lỗi kết nối thay vì đoán.
				if (!cancelled) setStatusError('Không kết nối được API. Kiểm tra mạng rồi tải lại trang.');
			} finally {
				if (!cancelled) setLoading(false);
			}
		})();
		return () => {
			cancelled = true;
		};
	}, []);

	const navigate = (view: WorkspaceView) => {
		setRoute({ kind: 'files', view });
		window.history.pushState(null, '', pathForView(view));
	};

	if (route.kind === 'share') {
		return (
			<ToastProvider>
				<SharePage token={route.token} />
			</ToastProvider>
		);
	}

	if (loading) {
		return (
			<div className="boot" role="status" aria-live="polite">
				<span className="brand__mark">
					<Icon name="cloud" />
				</span>
				<span className="spinner" aria-hidden="true" />
				<span className="small muted">Đang kết nối AlkCloud…</span>
			</div>
		);
	}

	if (statusError) {
		return (
			<main className="boot" role="alert">
				<span className="brand__mark">
					<Icon name="cloud" />
				</span>
				<p className="small" style={{ color: 'var(--danger)', maxWidth: '44ch', textAlign: 'center' }}>
					{statusError}
				</p>
				<button type="button" className="btn btn--primary" onClick={() => window.location.reload()}>
					Tải lại
				</button>
			</main>
		);
	}

	if (!authenticated) {
		return (
			<ToastProvider>
				<LoginPage
					bootstrapped={Boolean(bootstrapped)}
					onAuthenticated={() => {
						setAuthenticated(true);
						navigate('files');
					}}
				/>
			</ToastProvider>
		);
	}

	return (
		<ToastProvider>
			<FilesPage
				view={route.kind === 'files' ? route.view : 'files'}
				onNavigate={navigate}
				ownerEmail={ownerEmail}
				onLogout={() => {
					setAuthenticated(false);
					setOwnerEmail(null);
					setRoute({ kind: 'login' });
					window.history.replaceState(null, '', '/');
				}}
			/>
		</ToastProvider>
	);
}
