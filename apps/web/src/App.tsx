import { useEffect, useState } from 'react';
import { getAuthStatus, getSession, setCsrfToken } from './lib/api.js';
import { LoginPage } from './pages/LoginPage.js';
import { FilesPage } from './pages/FilesPage.js';
import { SharePage } from './pages/SharePage.js';

export type Route =
	| { kind: 'login' }
	| { kind: 'files' }
	| { kind: 'share'; token: string };

export function parseRoute(): Route {
	const path = window.location.pathname;
	// Share token nằm trong fragment: `#<token>` — không bao giờ gửi lên server.
	if (path === '/s' || path.startsWith('/s/')) {
		const token = window.location.hash.replace(/^#/, '').trim();
		return { kind: 'share', token };
	}
	return { kind: 'login' };
}

export function App() {
	const [route, setRoute] = useState<Route>(() => parseRoute());
	const [bootstrapped, setBootstrapped] = useState<boolean | null>(null);
	const [authenticated, setAuthenticated] = useState(false);
	const [loading, setLoading] = useState(true);

	useEffect(() => {
		const onPopState = () => setRoute(parseRoute());
		window.addEventListener('popstate', onPopState);
		return () => window.removeEventListener('popstate', onPopState);
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
						if (!cancelled) setAuthenticated(true);
					} catch {
						if (!cancelled) setAuthenticated(false);
					}
				}
			} catch {
				if (!cancelled) setBootstrapped(false);
			} finally {
				if (!cancelled) setLoading(false);
			}
		})();
		return () => {
			cancelled = true;
		};
	}, []);

	if (loading) {
		return (
			<main className="center">
				<p>Đang tải…</p>
			</main>
		);
	}

	if (route.kind === 'share') {
		return <SharePage token={route.token} />;
	}

	if (!authenticated) {
		return (
			<LoginPage
				bootstrapped={Boolean(bootstrapped)}
				onAuthenticated={() => {
					setAuthenticated(true);
					setRoute({ kind: 'files' });
				}}
			/>
		);
	}

	return <FilesPage onLogout={() => setAuthenticated(false)} />;
}
