#!/usr/bin/env node
/**
 * Phase 5 — xác minh luồng auth production (login / logout / session / recovery).
 *
 * - Đọc credential từ file local mode 600, KHÔNG in giá trị.
 * - Dùng đúng thuật toán client (Argon2id + salt từ GET /auth/params).
 * - Recovery: thử 1 mã THẬT (xác minh flow hoạt động) ⇒ mã đó bị tiêu thụ
 *   ⇒ regenerate toàn bộ mã và lưu lại (file 600) để owner có bộ mã mới.
 */
import { readFileSync, writeFileSync, existsSync, chmodSync } from 'node:fs';
import { resolve } from 'node:path';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { argon2id } = require('hash-wasm');
const crypto = require('node:crypto');

const API = process.env.ALKCLOUD_E2E_API_URL ?? 'https://api.alk.xx.kg/api/v1';
const ORIGIN = process.env.ALKCLOUD_E2E_ORIGIN ?? 'https://cloud.alk.xx.kg';
const SECRETS_FILE = resolve(process.env.ALKCLOUD_SECRETS_FILE ?? 'deploy/production-secrets.env');
const RECOVERY_FILE = resolve(process.env.ALKCLOUD_RECOVERY_FILE ?? 'deploy/owner-recovery-codes.txt');

let failures = 0;
function check(name: string, ok: boolean, detail = ''): void {
	console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? ` — ${detail}` : ''}`);
	if (!ok) failures += 1;
}

function readEnvFile(path: string): Record<string, string> {
	const out: Record<string, string> = {};
	if (!existsSync(path)) return out;
	for (const line of readFileSync(path, 'utf8').split('\n')) {
		const trimmed = line.trim();
		if (!trimmed || trimmed.startsWith('#')) continue;
		const index = trimmed.indexOf('=');
		if (index === -1) continue;
		out[trimmed.slice(0, index)] = trimmed.slice(index + 1);
	}
	return out;
}

function b64u(bytes: Uint8Array): string {
	return Buffer.from(bytes).toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

async function deriveAuthKey(password: string, saltB64u: string, paramsRaw: string): Promise<string> {
	const params = paramsRaw
		? (JSON.parse(paramsRaw) as { memorySize: number; iterations: number; parallelism: number; outputLength: number })
		: { memorySize: 19_456, iterations: 2, parallelism: 1, outputLength: 32 };
	const saltBytes = Buffer.from(saltB64u.replace(/-/g, '+').replace(/_/g, '/'), 'base64');
	const hash = await argon2id({
		password,
		salt: saltBytes,
		parallelism: params.parallelism,
		iterations: params.iterations,
		memorySize: params.memorySize,
		hashLength: params.outputLength,
		outputType: 'binary',
	});
	return b64u(new Uint8Array(hash));
}

function cookieFrom(response: Response): string {
	const raw = response.headers.get('set-cookie');
	if (!raw) return '';
	return raw.split(';')[0] ?? '';
}

async function main(): Promise<void> {
	const env = readEnvFile(SECRETS_FILE);
	const email = env.OWNER_EMAIL!;
	const password = env.OWNER_PASSWORD!;

	// 1. Lấy salt/params của owner (public endpoint).
	const paramsResponse = await fetch(`${API}/auth/params`, { headers: { origin: ORIGIN } });
	const paramsBody = (await paramsResponse.json()) as { salt: string; params: string };
	check('GET /auth/params trả salt/params', paramsResponse.status === 200 && paramsBody.salt.length >= 8);

	// 2. Login sai mật khẩu ⇒ 401 (không tiết lộ).
	const badResponse = await fetch(`${API}/auth/login`, {
		method: 'POST',
		headers: { 'content-type': 'application/json', origin: ORIGIN },
		body: JSON.stringify({ email, authKey: b64u(crypto.randomBytes(32)) }),
	});
	check('login sai mật khẩu bị từ chối', badResponse.status === 401, `HTTP ${badResponse.status}`);

	// 3. Login đúng.
	const authKey = await deriveAuthKey(password, paramsBody.salt, paramsBody.params);
	const loginResponse = await fetch(`${API}/auth/login`, {
		method: 'POST',
		headers: { 'content-type': 'application/json', origin: ORIGIN },
		body: JSON.stringify({ email, authKey }),
	});
	const loginBody = (await loginResponse.json()) as { session?: { csrfToken: string }; error?: { code: string } };
	const cookie = cookieFrom(loginResponse);
	check(
		'login đúng mật khẩu trả session + cookie',
		loginResponse.status === 200 && cookie.length > 0 && Boolean(loginBody.session?.csrfToken),
		`HTTP ${loginResponse.status}`,
	);

	// 4. Session persistence + endpoint owner-only.
	// Endpoint trả 401 khi không có phiên ⇒ HTTP 200 + owner khớp = phiên hợp lệ.
	const sessionResponse = await fetch(`${API}/auth/session`, { headers: { origin: ORIGIN, cookie } });
	const sessionBody = (await sessionResponse.json()) as {
		owner?: { email: string };
		session?: { id: string; expiresAt: string };
		recoveryCodesRemaining?: number;
	};
	check(
		'GET /auth/session xác nhận phiên',
		sessionResponse.status === 200 && sessionBody.owner?.email === email && Boolean(sessionBody.session?.id),
		`recovery_codes_remaining=${sessionBody.recoveryCodesRemaining ?? 'n/a'}`,
	);

	// 5. Owner-only endpoint hoạt động với cookie + CSRF.
	const csrf = loginBody.session!.csrfToken;
	const quotaResponse = await fetch(`${API}/system/quota`, { headers: { origin: ORIGIN, cookie } });
	check('GET /system/quota (owner-only) OK', quotaResponse.status === 200, `HTTP ${quotaResponse.status}`);

	// 6. CSRF bắt buộc cho method ghi.
	const noCsrf = await fetch(`${API}/folders`, {
		method: 'POST',
		headers: { 'content-type': 'application/json', origin: ORIGIN, cookie },
		body: JSON.stringify({ name: 'csrf-probe' }),
	});
	check('POST /folders thiếu CSRF bị chặn', noCsrf.status === 403, `HTTP ${noCsrf.status}`);

	// 7. Origin sai bị chặn.
	const badOrigin = await fetch(`${API}/auth/login`, {
		method: 'POST',
		headers: { 'content-type': 'application/json', origin: 'https://evil.example' },
		body: JSON.stringify({ email, authKey }),
	});
	check('login với Origin sai bị chặn', badOrigin.status === 403, `HTTP ${badOrigin.status}`);

	// 8. Recovery flow: mã sai ⇒ 401.
	const wrongCode = await fetch(`${API}/auth/recovery-login`, {
		method: 'POST',
		headers: { 'content-type': 'application/json', origin: ORIGIN },
		body: JSON.stringify({ email, code: 'AAAA-BBBB' }),
	});
	check('recovery-login mã sai bị từ chối', wrongCode.status === 401, `HTTP ${wrongCode.status}`);

	// 9. Recovery flow thật.
	//
	// Thứ tự để mỗi lần chạy đều an toàn và idempotent:
	//   a) regenerate bằng phiên đăng nhập hiện tại ⇒ có bộ mã MỚI, hợp lệ
	//   b) dùng 1 mã trong bộ mới để thử recovery-login (mã này bị tiêu thụ)
	//   c) regenerate lại bằng phiên recovery ⇒ bộ mã CUỐI CÙNG còn nguyên cho owner
	// Nhờ vậy không mất mã nào mà owner chưa lưu, và file luôn chứa 10 mã dùng được.
	let recoveryCookie = '';
	let recoveryCsrf = csrf;
	if (!existsSync(RECOVERY_FILE)) {
		check('file recovery codes tồn tại', false, RECOVERY_FILE);
	} else {
		const regenerate = async (cookieValue: string, csrfValue: string) => {
			const response = await fetch(`${API}/auth/recovery-codes/regenerate`, {
				method: 'POST',
				headers: {
					'content-type': 'application/json',
					origin: ORIGIN,
					cookie: cookieValue,
					'x-alkcloud-csrf': csrfValue,
				},
			});
			const body = (await response.json()) as { recoveryCodes?: string[]; error?: { code: string } };
			return { response, codes: body.recoveryCodes ?? [] };
		};

		const first = await regenerate(cookie, csrf);
		check(
			'regenerate recovery codes (phiên đăng nhập) trả bộ mã mới',
			first.response.status === 200 && first.codes.length === 10,
			`HTTP ${first.response.status} count=${first.codes.length}`,
		);

		const recoveryResponse = await fetch(`${API}/auth/recovery-login`, {
			method: 'POST',
			headers: { 'content-type': 'application/json', origin: ORIGIN },
			body: JSON.stringify({ email, code: first.codes[0] }),
		});
		check(
			'recovery-login với mã thật thành công',
			recoveryResponse.status === 200,
			`HTTP ${recoveryResponse.status} (mã đã dùng 1 lần)`,
		);

		if (recoveryResponse.status === 200) {
			// Recovery-login thu hồi MỌI session cũ (trừ session vừa tạo) — đúng
			// thiết kế (dấu hiệu mất quyền kiểm soát). ⇒ dùng cookie + CSRF MỚI.
			recoveryCookie = cookieFrom(recoveryResponse);
			const recoveryBody = (await recoveryResponse.clone().json()) as { session?: { csrfToken: string } };
			recoveryCsrf = recoveryBody.session?.csrfToken ?? csrf;
			const revokedProbe = await fetch(`${API}/auth/session`, { headers: { origin: ORIGIN, cookie } });
			check(
				'recovery-login thu hồi session cũ',
				revokedProbe.status === 401,
				`session_cũ=${revokedProbe.status} (mong đợi 401)`,
			);

			// Regenerate lần 2 ⇒ bộ mã CUỐI CÙNG còn nguyên cho owner.
			const second = await regenerate(recoveryCookie, recoveryCsrf);
			check(
				'regenerate lần 2 trả bộ mã cuối cùng cho owner',
				second.response.status === 200 && second.codes.length === 10,
				`HTTP ${second.response.status} count=${second.codes.length}`,
			);
			if (second.codes.length === 10) {
				writeFileSync(
					RECOVERY_FILE,
					[
						'# AlkCloud — RECOVERY CODES (mỗi mã dùng 1 lần)',
						'# Sinh lúc: ' + new Date().toISOString() + ' (sau regenerate — bộ trước đã vô hiệu)',
						'# Lưu vào password manager rồi XOÁ file này.',
						...second.codes,
						'',
					].join('\n'),
					{ mode: 0o600 },
				);
				chmodSync(RECOVERY_FILE, 0o600);
				console.log(`Đã ghi bộ recovery codes MỚI vào ${RECOVERY_FILE} (mode 600).`);
			}
		}
	}

	// 10. Logout ⇒ cookie không còn dùng được (dùng phiên hiện hành).
	const activeCookie = recoveryCookie || cookie;
	const activeCsrf = recoveryCsrf || csrf;
	const logoutResponse = await fetch(`${API}/auth/logout`, {
		method: 'POST',
		headers: {
			'content-type': 'application/json',
			origin: ORIGIN,
			cookie: activeCookie,
			'x-alkcloud-csrf': activeCsrf,
		},
	});
	const afterLogout = await fetch(`${API}/auth/session`, { headers: { origin: ORIGIN, cookie: activeCookie } });
	check(
		'logout huỷ phiên',
		logoutResponse.status === 200 && afterLogout.status !== 200,
		`logout=${logoutResponse.status} session_after=${afterLogout.status}`,
	);

	console.log(failures === 0 ? '\nTẤT CẢ KIỂM TRA AUTH PASS' : `\n${failures} KIỂM TRA FAIL`);
	process.exit(failures === 0 ? 0 : 1);
}

main().catch((error: unknown) => {
	console.error('Lỗi:', error instanceof Error ? error.message : String(error));
	process.exit(1);
});
