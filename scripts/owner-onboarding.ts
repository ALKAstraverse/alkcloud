import { execFileSync } from 'node:child_process';
import { chmodSync, existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { randomBytes } from 'node:crypto';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

/**
 * WS-L2/M13 — Owner onboarding CLI.
 *
 * Owner sắp triển khai lần đầu và phải đi qua 5 blocker (B3/B4/B5/B6/B7) +
 * 14 secret. Hiện có nhiều script kiểm tra rời rạc (`check-b2.sh`,
 * `check-cloudflare-token.sh`, `check-d1.sh`, `check-dns.sh`,
 * `check-owner-prerequisites.sh`) ⇒ owner phải tự biết chạy cái nào, theo thứ
 * tự nào, và sau đó làm gì khi nó FAIL.
 *
 * CLI này gom tất cả thành **một lệnh** với checklist trực quan, kèm đúng
 * lệnh cần chạy tiếp theo cho từng mục chưa xong.
 *
 * Action classification:
 *   - `status` / `checklist` : READ_ONLY (chạy script kiểm tra read-only)
 *   - `secrets`              : LOCAL_WRITE (sinh ngẫu nhiên cục bộ, file 600)
 *   - KHÔNG bao giờ: deploy, tạo tài nguyên, ghi D1/DNS/secret production.
 *
 * KHÔNG bao giờ in giá trị secret ra terminal (terminal có thể bị chia sẻ màn
 * hình / ghi log) ⇒ giá trị sinh ra nằm trong file local mode 600.
 */

const ROOT = resolve(fileURLToPath(new URL('..', import.meta.url)));
const DEPLOY_DIR = join(ROOT, 'deploy');
const LOCAL_SECRETS_FILE = join(DEPLOY_DIR, 'local-secrets.env');

export type StepStatus = 'pass' | 'fail' | 'not_configured' | 'permission_denied' | 'skipped' | 'unknown';

export interface CheckLine {
	status: StepStatus;
	name: string;
	detail: string;
}

export interface OnboardingStep {
	id: string;
	title: string;
	command: string;
	nextAction: string;
	lines: CheckLine[];
	status: StepStatus;
}

const STATUS_TOKENS: { token: string; status: StepStatus }[] = [
	{ token: 'PERMISSION_DENIED', status: 'permission_denied' },
	{ token: 'NOT_CONFIGURED', status: 'not_configured' },
	{ token: 'SKIPPED', status: 'skipped' },
	{ token: 'FAIL', status: 'fail' },
	{ token: 'PASS', status: 'pass' },
];

/** Parse output chuẩn của `infra/check-*.sh`: `STATUS<space>NAME — DETAIL`. */
export function parseCheckOutput(output: string): CheckLine[] {
	const lines: CheckLine[] = [];
	for (const raw of output.split('\n')) {
		const line = raw.replace(/\[[0-9;]*m/g, '').trimEnd();
		if (!line.trim()) continue;
		const match = /^(PERMISSION_DENIED|NOT_CONFIGURED|SKIPPED|FAIL|PASS)\s+(.+)$/.exec(line.trim());
		if (!match) continue;
		const status = STATUS_TOKENS.find((t) => t.token === match[1])!.status;
		const body = match[2]!;
		const dash = body.indexOf('—');
		const name = (dash === -1 ? body : body.slice(0, dash)).trim();
		const detail = dash === -1 ? '' : body.slice(dash + 1).trim();
		lines.push({ status, name, detail });
	}
	return lines;
}

/** Trạng thái tổng hợp của 1 bước: điểm yếu nhất quyết định. */
export function aggregateStatus(lines: CheckLine[]): StepStatus {
	if (lines.length === 0) return 'unknown';
	const order: StepStatus[] = ['fail', 'permission_denied', 'not_configured', 'skipped', 'pass'];
	for (const status of order) {
		if (lines.some((line) => line.status === status)) return status;
	}
	return 'unknown';
}

function runScript(name: string): { output: string; exitCode: number } {
	try {
		const output = execFileSync('bash', [join(ROOT, 'infra', name)], {
			cwd: ROOT,
			encoding: 'utf8',
			stdio: ['ignore', 'pipe', 'pipe'],
		});
		return { output, exitCode: 0 };
	} catch (error) {
		const err = error as { stdout?: string; stderr?: string; status?: number };
		return {
			output: `${err.stdout ?? ''}${err.stderr ?? ''}`,
			exitCode: typeof err.status === 'number' ? err.status : 1,
		};
	}
}

const STEP_DEFINITIONS: {
	id: string;
	title: string;
	script: string;
	command: string;
	nextAction: string;
}[] = [
	{
		id: 'B3',
		title: 'B2 bucket + 2 app key',
		script: 'check-b2.sh',
		command: './infra/check-b2.sh',
		nextAction: 'Tạo bucket private + 2 app key giới hạn theo bucket → docs/20 §B3',
	},
	{
		id: 'B4',
		title: 'Cloudflare API token (Account Analytics:Read)',
		script: 'check-cloudflare-token.sh',
		command: './infra/check-cloudflare-token.sh',
		nextAction: 'Tạo token có Account Analytics:Read → docs/20 §B4',
	},
	{
		id: 'B6',
		title: 'D1 database',
		script: 'check-d1.sh',
		command: './infra/check-d1.sh',
		nextAction: 'npx wrangler d1 create alkcloud → cập nhật database_id → docs/20 §B6',
	},
	{
		id: 'B7',
		title: 'DNS cloud.alk.xx.kg',
		script: 'check-dns.sh',
		command: './infra/check-dns.sh',
		nextAction: 'Tạo CNAME cloud.alk.xx.kg → workers.dev → docs/20 §B7',
	},
];

export function collectSteps(): OnboardingStep[] {
	return STEP_DEFINITIONS.map((definition) => {
		const { output } = runScript(definition.script);
		const lines = parseCheckOutput(output);
		return {
			id: definition.id,
			title: definition.title,
			command: definition.command,
			nextAction: definition.nextAction,
			lines,
			status: aggregateStatus(lines),
		};
	});
}

/** Secret do owner/CLI sinh được (không cần dịch vụ ngoài). */
const GENERATED_SECRETS = ['AUTH_PEPPER', 'BOOTSTRAP_SETUP_TOKEN'] as const;

/** Secret phải lấy từ dịch vụ ngoài — CLI chỉ chỉ ra nơi lấy. */
const EXTERNAL_SECRETS: { name: string; source: string }[] = [
	{ name: 'B2_ENDPOINT', source: 'B2 console (region + endpoint)' },
	{ name: 'B2_REGION', source: 'B2 console' },
	{ name: 'B2_BUCKET', source: 'B2 console (bucket private)' },
	{ name: 'B2_ACCESS_KEY_ID', source: 'B2 console (app key chính)' },
	{ name: 'B2_SECRET_ACCESS_KEY', source: 'B2 console (app key chính)' },
	{ name: 'B2_MAINTENANCE_ACCESS_KEY_ID', source: 'B2 console (app key bảo trì)' },
	{ name: 'B2_MAINTENANCE_SECRET_ACCESS_KEY', source: 'B2 console (app key bảo trì)' },
	{ name: 'TURNSTILE_SITE_KEY', source: 'Cloudflare Turnstile' },
	{ name: 'TURNSTILE_SECRET_KEY', source: 'Cloudflare Turnstile' },
	{ name: 'ALERT_WEBHOOK_URL', source: 'Owner chọn kênh alert (B5)' },
	{ name: 'CLOUDFLARE_ANALYTICS_TOKEN', source: 'Cloudflare API token (B4)' },
	{ name: 'CLOUDFLARE_ACCOUNT_ID', source: 'Cloudflare dashboard' },
];

export interface GeneratedSecrets {
	file: string;
	created: string[];
	kept: string[];
}

/**
 * Sinh các secret có thể sinh cục bộ (pepper + bootstrap token).
 *
 * - Ghi vào file mode 600 trong `deploy/` (gitignored) — KHÔNG in ra terminal.
 * - Không ghi đè giá trị đã có (giữ nguyên pepper ⇒ không phá phiên/share).
 * - Idempotent: chạy lại vẫn an toàn.
 */
export function generateLocalSecrets(): GeneratedSecrets {
	mkdirSync(DEPLOY_DIR, { recursive: true });
	const existing = existsSync(LOCAL_SECRETS_FILE) ? readFileSync(LOCAL_SECRETS_FILE, 'utf8') : '';
	const existingNames = new Set(
		existing
			.split('\n')
			.map((line) => /^\s*([A-Z][A-Z0-9_]*)=/.exec(line)?.[1])
			.filter((name): name is string => Boolean(name)),
	);

	const created: string[] = [];
	const kept: string[] = [];
	const additions: string[] = [];
	for (const name of GENERATED_SECRETS) {
		if (existingNames.has(name)) {
			kept.push(name);
			continue;
		}
		created.push(name);
		const value = name === 'AUTH_PEPPER' ? randomBytes(32).toString('base64url') : randomBytes(24).toString('base64url');
		additions.push(`${name}=${value}`);
	}

	if (additions.length > 0) {
		const header = [
			'# AlkCloud — secret sinh cục bộ (KHÔNG COMMIT, KHÔNG in ra terminal)',
			'# Đặt vào Worker bằng:  npx wrangler secret put <TÊN>  < deploy/local-secrets.env',
			'# ⚠️ ĐỔI AUTH_PEPPER ⇒ mất toàn bộ phiên đăng nhập + share cũ.',
			'# ⚠️ File này phải được xoá sau khi đặt xong secret (và KHÔNG backup lên cloud).',
			'',
		].join('\n');
		writeFileSync(
			LOCAL_SECRETS_FILE,
			`${header}${existing && !existing.endsWith('\n') ? `${existing}\n` : existing}${additions.join('\n')}\n`,
			{ mode: 0o600 },
		);
	}
	chmodSync(LOCAL_SECRETS_FILE, 0o600);
	return { file: LOCAL_SECRETS_FILE, created, kept };
}

const ICONS: Record<StepStatus, string> = {
	pass: '[✔]',
	fail: '[✘]',
	not_configured: '[○]',
	permission_denied: '[!]',
	skipped: '[~]',
	unknown: '[?]',
};

const LABELS: Record<StepStatus, string> = {
	pass: 'OK',
	fail: 'FAIL',
	not_configured: 'CHƯA CẤU HÌNH',
	permission_denied: 'THIẾU QUYỀN',
	skipped: 'BỎ QUA',
	unknown: 'KHÔNG RÕ',
};

function renderStatus(steps: OnboardingStep[]): void {
	console.log('');
	console.log('═══ AlkCloud — Owner onboarding ═══');
	console.log('(read-only — KHÔNG deploy, KHÔNG tạo tài nguyên)');
	console.log('');
	for (const step of steps) {
		console.log(`${ICONS[step.status]} ${step.id} — ${step.title}  [${LABELS[step.status]}]`);
		for (const line of step.lines) {
			console.log(`      ${ICONS[line.status]} ${line.name}${line.detail ? ` — ${line.detail}` : ''}`);
		}
		if (step.status !== 'pass') {
			console.log(`      → CẦN LÀM: ${step.nextAction}`);
			console.log(`        (kiểm tra lại: ${step.command})`);
		}
		console.log('');
	}
	const blocking = steps.filter((step) => step.status !== 'pass');
	console.log('─────────────────────────────────────────');
	if (blocking.length === 0) {
		console.log('KẾT QUẢ: tài nguyên đã sẵn sàng. Bước tiếp theo: đặt 14 secret →');
		console.log('  npm run owner:onboarding -- secrets');
	} else {
		console.log(`KẾT QUẢ: CHƯA SẴN SÀNG — ${blocking.length}/${steps.length} bước còn vướng:`);
		for (const step of blocking) console.log(`  - ${step.id}: ${step.title} (${LABELS[step.status]})`);
	}
	console.log('');
}

function renderSecrets(): void {
	const result = generateLocalSecrets();
	console.log('');
	console.log('═══ AlkCloud — secret ═══');
	console.log('');
	console.log(`File local (mode 600, gitignored): ${result.file.replace(`${ROOT}/`, '')}`);
	if (result.created.length > 0) {
		console.log(`  Đã sinh mới: ${result.created.join(', ')}`);
	}
	if (result.kept.length > 0) {
		console.log(`  Giữ nguyên (đã tồn tại): ${result.kept.join(', ')}`);
	}
	console.log('');
	console.log('Đặt từng secret vào Worker (KHÔNG in giá trị):');
	console.log('  npx wrangler secret put AUTH_PEPPER');
	console.log('  npx wrangler secret put BOOTSTRAP_SETUP_TOKEN');
	console.log('');
	console.log('Secret lấy từ dịch vụ ngoài (CLI không sinh được):');
	for (const secret of EXTERNAL_SECRETS) {
		console.log(`  ${secret.name.padEnd(34)} ← ${secret.source}`);
	}
	console.log('');
	console.log('⚠️  ĐỔI AUTH_PEPPER sau khi dùng ⇒ mất toàn bộ phiên đăng nhập + share cũ.');
	console.log('⚠️  Xoá file local sau khi đặt xong; KHÔNG backup lên cloud.');
	console.log('');
}

function main(): void {
	const args = process.argv.slice(2);
	const command = args.find((arg) => !arg.startsWith('-')) ?? 'status';
	const json = args.includes('--json');

	if (command === 'secrets') {
		if (json) {
			const result = generateLocalSecrets();
			console.log(JSON.stringify({ file: result.file, created: result.created, kept: result.kept }, null, 2));
			return;
		}
		renderSecrets();
		return;
	}

	if (command !== 'status' && command !== 'checklist') {
		console.error(`Lệnh không hợp lệ: ${command}`);
		console.error('Dùng: status | secrets');
		process.exit(2);
	}

	const steps = collectSteps();
	if (json) {
		console.log(JSON.stringify({ steps, ready: steps.every((step) => step.status === 'pass') }, null, 2));
	} else {
		renderStatus(steps);
	}
	// Exit code: 0 = sẵn sàng, 1 = còn vướng, 2 = sai tham số.
	process.exit(steps.every((step) => step.status === 'pass') ? 0 : 1);
}

if (process.argv[1] && import.meta.url.endsWith(process.argv[1].split('/').pop() ?? '')) {
	main();
}
