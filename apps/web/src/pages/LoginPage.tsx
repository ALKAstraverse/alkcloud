import { useState } from 'react';
import { bootstrap, getAuthParams, login, recoveryLogin } from '../lib/api.js';
import { deriveAuthKey, parseKdfParams, randomSalt } from '../lib/kdf.js';

interface LoginPageProps {
	bootstrapped: boolean;
	onAuthenticated: () => void;
}

type Mode = 'password' | 'recovery' | 'bootstrap';

export function LoginPage({ bootstrapped, onAuthenticated }: LoginPageProps) {
	const [mode, setMode] = useState<Mode>(bootstrapped ? 'password' : 'bootstrap');
	const [email, setEmail] = useState('');
	const [password, setPassword] = useState('');
	const [recoveryCode, setRecoveryCode] = useState('');
	const [setupToken, setSetupToken] = useState('');
	const [busy, setBusy] = useState(false);
	const [error, setError] = useState<string | null>(null);
	const [recoveryCodes, setRecoveryCodes] = useState<string[] | null>(null);

	const submit = async (event: React.FormEvent) => {
		event.preventDefault();
		setBusy(true);
		setError(null);
		try {
			if (mode === 'password') {
				// Salt/params phải khớp lúc đăng ký → lấy từ server.
				const stored = await getAuthParams();
				const derived = await deriveAuthKey(password, stored.salt, parseKdfParams(stored.params));
				await login(email, derived.authKey);
				onAuthenticated();
			} else if (mode === 'recovery') {
				await recoveryLogin(email, recoveryCode);
				onAuthenticated();
			} else {
				const salt = randomSalt();
				const derived = await deriveAuthKey(password, salt);
				const result = await bootstrap({
					setupToken,
					email,
					authKey: derived.authKey,
					authVerifierSalt: derived.authVerifierSalt,
					authParams: derived.authParams,
				});
				setRecoveryCodes(result.recoveryCodes);
				onAuthenticated();
			}
		} catch (caught) {
			setError(caught instanceof Error ? caught.message : 'Có lỗi xảy ra');
		} finally {
			setBusy(false);
		}
	};

	if (recoveryCodes) {
		return (
			<main className="center">
				<section className="card">
					<h1>Lưu mã khôi phục</h1>
					<p className="warn">
						Mã khôi phục chỉ hiển thị một lần. Lưu lại ở nơi an toàn — mỗi mã chỉ dùng được
						một lần.
					</p>
					<ul className="codes">
						{recoveryCodes.map((code) => (
							<li key={code}>
								<code>{code}</code>
							</li>
						))}
					</ul>
					<button type="button" onClick={onAuthenticated}>
						Đã lưu — vào ứng dụng
					</button>
				</section>
			</main>
		);
	}

	return (
		<main className="center">
			<section className="card">
				<h1>AlkCloud</h1>
				<p className="muted">Lưu trữ riêng tư của bạn</p>

				{mode === 'bootstrap' && (
					<p className="warn">
						Chưa khởi tạo. Nhập setup token (biến môi trường BOOTSTRAP_SETUP_TOKEN) để tạo
						tài khoản owner.
					</p>
				)}

				<form onSubmit={submit}>
					<label>
						Email
						<input
							type="email"
							value={email}
							onChange={(event) => setEmail(event.target.value)}
							required
							autoComplete="username"
						/>
					</label>

					{mode !== 'recovery' && (
						<label>
							Mật khẩu
							<input
								type="password"
								value={password}
								onChange={(event) => setPassword(event.target.value)}
								required
								autoComplete={mode === 'bootstrap' ? 'new-password' : 'current-password'}
							/>
						</label>
					)}

					{mode === 'recovery' && (
						<label>
							Mã khôi phục
							<input
								value={recoveryCode}
								onChange={(event) => setRecoveryCode(event.target.value)}
								required
								placeholder="XXXX-XXXX-XXXX"
							/>
						</label>
					)}

					{mode === 'bootstrap' && (
						<label>
							Setup token
							<input
								value={setupToken}
								onChange={(event) => setSetupToken(event.target.value)}
								required
								autoComplete="off"
							/>
						</label>
					)}

					{error && <p className="error">{error}</p>}

					<button type="submit" disabled={busy}>
						{busy
							? 'Đang xử lý…'
							: mode === 'bootstrap'
								? 'Khởi tạo'
								: mode === 'recovery'
									? 'Đăng nhập bằng mã khôi phục'
									: 'Đăng nhập'}
					</button>
				</form>

				{bootstrapped && (
					<div className="row">
						{mode !== 'recovery' ? (
							<button type="button" className="link" onClick={() => setMode('recovery')}>
								Dùng mã khôi phục
							</button>
						) : (
							<button type="button" className="link" onClick={() => setMode('password')}>
								Quay lại đăng nhập
							</button>
						)}
					</div>
				)}

				<p className="muted small">
					Mật khẩu được băm PBKDF2 ngay trong trình duyệt; server chỉ nhận giá trị đã băm.
				</p>
				<p className="muted small">build {__BUILD_ID__}</p>
			</section>
		</main>
	);
}
