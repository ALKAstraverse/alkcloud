import { useCallback, useState } from 'react';
import { bootstrap, getAuthParams, login, recoveryLogin } from '../lib/api.js';
import { deriveAuthKey, parseKdfParams, randomSalt } from '../lib/kdf.js';
import { Button, IconButton } from '../components/Button.js';
import { Icon } from '../components/Icon.js';
import { InlineNotice } from '../components/States.js';
import { useTheme } from '../lib/theme.js';

interface LoginPageProps {
	bootstrapped: boolean;
	onAuthenticated: () => void;
}

type Mode = 'password' | 'recovery' | 'bootstrap';

export function LoginPage({ bootstrapped, onAuthenticated }: LoginPageProps) {
	const { theme, toggle: toggleTheme } = useTheme();
	const [mode, setMode] = useState<Mode>(bootstrapped ? 'password' : 'bootstrap');
	const [email, setEmail] = useState('');
	const [password, setPassword] = useState('');
	const [recoveryCode, setRecoveryCode] = useState('');
	const [setupToken, setSetupToken] = useState('');
	const [showPassword, setShowPassword] = useState(false);
	const [capsLock, setCapsLock] = useState(false);
	const [busy, setBusy] = useState(false);
	const [error, setError] = useState<string | null>(null);
	const [recoveryCodes, setRecoveryCodes] = useState<string[] | null>(null);
	const [saved, setSaved] = useState(false);

	const onKeyUp = useCallback((event: React.KeyboardEvent) => {
		if (typeof event.getModifierState === 'function') setCapsLock(event.getModifierState('CapsLock'));
	}, []);

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
			}
		} catch (caught) {
			setError(caught instanceof Error ? caught.message : 'Có lỗi xảy ra');
		} finally {
			setBusy(false);
		}
	};

	// Sau khi bootstrap: bắt buộc xác nhận đã lưu mã khôi phục trước khi vào app.
	if (recoveryCodes) {
		return (
			<div className="auth">
				<aside className="auth__aside" aria-hidden="true">
					<div className="brand" style={{ padding: 0 }}>
						<span className="brand__mark">
							<Icon name="cloud" />
						</span>
						<span>
							<span className="brand__name" style={{ color: '#fff' }}>
								AlkCloud
							</span>
						</span>
					</div>
					<div className="auth__aside-inner">
						<h1 className="auth__headline">Tài khoản đã sẵn sàng.</h1>
						<p className="auth__lead">
							Lưu bộ mã khôi phục ở nơi an toàn. Đây là cách duy nhất để vào lại khi quên mật khẩu.
						</p>
					</div>
				</aside>
				<main className="auth__panel">
					<div className="auth__card">
						<div className="auth__brand-mobile brand" style={{ padding: 0 }}>
							<span className="brand__mark">
								<Icon name="cloud" />
							</span>
							<span className="brand__name">AlkCloud</span>
						</div>
						<div>
							<h1 className="auth__title">Lưu mã khôi phục</h1>
							<p className="auth__subtitle">
								Mỗi mã chỉ dùng được một lần. Không chia sẻ những mã này với bất kỳ ai.
							</p>
						</div>
						<InlineNotice tone="warning" title="Chỉ hiển thị một lần">
							Nếu rời trang trước khi lưu, bạn sẽ phải tạo bộ mã mới trong Cài đặt → Bảo mật.
						</InlineNotice>
						<div className="recovery-codes">
							{recoveryCodes.map((code) => (
								<span key={code} className="recovery-codes__item">
									{code}
								</span>
							))}
						</div>
						<div style={{ display: 'flex', flexDirection: 'column', gap: 'var(--space-4)' }}>
							<Button
								variant="secondary"
								icon="copy"
								block
								onClick={() => {
									void navigator.clipboard?.writeText(recoveryCodes.join('\n')).catch(() => {});
								}}
							>
								Sao chép tất cả
							</Button>
							<label className="checkbox">
								<input type="checkbox" checked={saved} onChange={(event) => setSaved(event.target.checked)} />
								Tôi đã lưu các mã này ở nơi an toàn
							</label>
							<Button variant="primary" icon="check" block disabled={!saved} onClick={onAuthenticated}>
								Vào AlkCloud
							</Button>
						</div>
					</div>
				</main>
			</div>
		);
	}

	const title =
		mode === 'bootstrap' ? 'Khởi tạo AlkCloud' : mode === 'recovery' ? 'Đăng nhập bằng mã khôi phục' : 'Đăng nhập';
	const subtitle =
		mode === 'bootstrap'
			? 'Tạo tài khoản chủ sở hữu đầu tiên bằng setup token.'
			: mode === 'recovery'
				? 'Nhập một trong các mã khôi phục bạn đã lưu khi tạo tài khoản.'
				: 'AlkCloud — lưu trữ riêng tư, mã hoá ngay trong trình duyệt.';

	return (
		<div className="auth">
			<aside className="auth__aside">
				<div className="brand" style={{ padding: 0 }}>
					<span className="brand__mark">
						<Icon name="cloud" />
					</span>
					<span>
						<span className="brand__name" style={{ color: '#fff' }}>
							AlkCloud
						</span>
					</span>
				</div>

				<div className="auth__aside-inner">
					<h1 className="auth__headline">Tệp của bạn. Chỉ của bạn.</h1>
					<p className="auth__lead">
						Kho lưu trữ cá nhân tự vận hành: mật khẩu không rời trình duyệt, tệp nằm trên hạ tầng riêng và
						không bị quét bởi bên thứ ba.
					</p>
					<ul className="auth__features">
						<li className="auth__feature">
							<span className="auth__feature-icon">
								<Icon name="lock" />
							</span>
							<span>
								<strong>Mật khẩu băm tại máy</strong> — PBKDF2 600 000 vòng, máy chủ chỉ nhận giá trị đã băm.
							</span>
						</li>
						<li className="auth__feature">
							<span className="auth__feature-icon">
								<Icon name="shareNodes" />
							</span>
							<span>
								<strong>Chia sẻ có kiểm soát</strong> — link có hạn, tuỳ chọn mật khẩu và giới hạn lượt tải.
							</span>
						</li>
						<li className="auth__feature">
							<span className="auth__feature-icon">
								<Icon name="shieldHalved" />
							</span>
							<span>
								<strong>Khôi phục an toàn</strong> — bộ mã dự phòng dùng một lần, lưu offline.
							</span>
						</li>
					</ul>
				</div>

				<p className="auth__foot">AlkCloud · hạ tầng riêng, không quảng cáo, không theo dõi.</p>
			</aside>

			<main className="auth__panel">
				<div className="auth__card">
					<div className="auth__brand-mobile brand" style={{ padding: 0 }}>
						<span className="brand__mark">
							<Icon name="cloud" />
						</span>
						<span>
							<span className="brand__name">AlkCloud</span>
							<span className="brand__tagline" style={{ display: 'block' }}>
								Lưu trữ cá nhân
							</span>
						</span>
						<span style={{ marginLeft: 'auto' }}>
							<IconButton
								icon={theme === 'dark' ? 'sun' : 'moon'}
								label={theme === 'dark' ? 'Chuyển sang nền sáng' : 'Chuyển sang nền tối'}
								onClick={toggleTheme}
							/>
						</span>
					</div>

					<div>
						<h1 className="auth__title">{title}</h1>
						<p className="auth__subtitle">{subtitle}</p>
					</div>

					{mode === 'bootstrap' ? (
						<InlineNotice tone="info" title="Chưa có tài khoản">
							Máy chủ chưa được khởi tạo. Nhập setup token (biến môi trường <code>BOOTSTRAP_SETUP_TOKEN</code>)
							để tạo chủ tài khoản.
						</InlineNotice>
					) : null}

					<form className="auth__form" onSubmit={submit}>
						<div className="field">
							<label className="field__label" htmlFor="login-email">
								Email
							</label>
							<div style={{ position: 'relative' }}>
								<input
									id="login-email"
									className="input"
									type="email"
									value={email}
									onChange={(event) => setEmail(event.target.value)}
									required
									autoComplete="username"
									autoFocus
									placeholder="ban@example.com"
									style={{ paddingLeft: 'calc(var(--space-5) + 20px)' }}
								/>
								<Icon
									name="envelope"
									style={{
										position: 'absolute',
										left: 'var(--space-5)',
										top: '50%',
										transform: 'translateY(-50%)',
										width: 14,
										height: 14,
										color: 'var(--text-muted)',
										pointerEvents: 'none',
									}}
								/>
							</div>
						</div>

						{mode !== 'recovery' ? (
							<div className="field">
								<label className="field__label" htmlFor="login-password">
									Mật khẩu
								</label>
								<div style={{ position: 'relative' }}>
									<input
										id="login-password"
										className="input"
										type={showPassword ? 'text' : 'password'}
										value={password}
										onChange={(event) => setPassword(event.target.value)}
										onKeyUp={onKeyUp}
										required
										minLength={mode === 'bootstrap' ? 12 : undefined}
										autoComplete={mode === 'bootstrap' ? 'new-password' : 'current-password'}
										placeholder={mode === 'bootstrap' ? 'Tối thiểu 12 ký tự' : '••••••••••••'}
										style={{
											paddingLeft: 'calc(var(--space-5) + 20px)',
											paddingRight: 'calc(var(--space-5) + 36px)',
										}}
									/>
									<Icon
										name="lock"
										style={{
											position: 'absolute',
											left: 'var(--space-5)',
											top: '50%',
											transform: 'translateY(-50%)',
											width: 14,
											height: 14,
											color: 'var(--text-muted)',
											pointerEvents: 'none',
										}}
									/>
									<button
										type="button"
										className="btn btn--ghost btn--sm btn--icon"
										aria-label={showPassword ? 'Ẩn mật khẩu' : 'Hiện mật khẩu'}
										onClick={() => setShowPassword((value) => !value)}
										style={{ position: 'absolute', right: 4, top: '50%', transform: 'translateY(-50%)' }}
									>
										<Icon name={showPassword ? 'eyeSlash' : 'eye'} />
									</button>
								</div>
								{capsLock ? <span className="field__hint">Caps Lock đang bật.</span> : null}
								{mode === 'bootstrap' ? (
									<span className="field__hint">
										Mật khẩu được băm trong trình duyệt; không thể khôi phục nếu mất mã dự phòng.
									</span>
								) : null}
							</div>
						) : (
							<div className="field">
								<label className="field__label" htmlFor="login-recovery">
									Mã khôi phục
								</label>
								<input
									id="login-recovery"
									className="input"
									value={recoveryCode}
									onChange={(event) => setRecoveryCode(event.target.value)}
									required
									autoComplete="one-time-code"
									placeholder="XXXX-XXXX-XXXX"
									style={{ fontFamily: 'var(--font-mono)', letterSpacing: '0.05em' }}
								/>
							</div>
						)}

						{mode === 'bootstrap' ? (
							<div className="field">
								<label className="field__label" htmlFor="login-setup">
									Setup token
								</label>
								<input
									id="login-setup"
									className="input"
									value={setupToken}
									onChange={(event) => setSetupToken(event.target.value)}
									required
									autoComplete="off"
									placeholder="Dán setup token từ máy chủ"
									style={{ fontFamily: 'var(--font-mono)' }}
								/>
							</div>
						) : null}

						{error ? (
							<span className="field__error" role="alert">
								<Icon name="circleExclamation" />
								{error}
							</span>
						) : null}

						<Button variant="primary" type="submit" size="lg" block loading={busy} icon="signIn" iconPosition="end">
							{mode === 'bootstrap' ? 'Khởi tạo tài khoản' : mode === 'recovery' ? 'Mở khoá tài khoản' : 'Đăng nhập'}
						</Button>
					</form>

					<div className="auth__alternatives">
						{bootstrapped ? (
							mode === 'recovery' ? (
								<Button variant="ghost" size="sm" icon="arrowLeft" onClick={() => setMode('password')}>
									Quay lại đăng nhập
								</Button>
							) : (
								<Button variant="ghost" size="sm" icon="key" onClick={() => setMode('recovery')}>
									Dùng mã khôi phục
								</Button>
							)
						) : (
							<span className="small muted">Máy chủ chưa có tài khoản.</span>
						)}
						{theme === 'light' || theme === 'dark' ? (
							<IconButton
								icon={theme === 'dark' ? 'sun' : 'moon'}
								label={theme === 'dark' ? 'Chuyển sang nền sáng' : 'Chuyển sang nền tối'}
								size="sm"
								onClick={toggleTheme}
							/>
						) : null}
					</div>

					<p className="auth__legal">
						AlkCloud không gửi email và không có “quên mật khẩu” truyền thống — hãy dùng mã khôi phục đã lưu.
						Brute-force bị chặn ở tầng API.
					</p>
				</div>
			</main>
		</div>
	);
}
