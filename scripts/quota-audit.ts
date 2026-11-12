#!/usr/bin/env node
/**
 * AlkCloud — Audit Workers Free / quota.
 *
 *   npm run audit:quota
 *
 * Kiểm tra (read-only, KHÔNG gọi Cloudflare API):
 *  1. Bundle Worker API + web có vượt giới hạn Workers Free không.
 *  2. Cấu hình budget trong wrangler.toml có hợp lệ so với trần cứng không.
 *  3. Ma trận degradation mode có bảo toàn tính toàn vẹn dữ liệu không
 *     (complete upload luôn được phép, owner download luôn được phép).
 *  4. Ngân sách subrequest: số lần gọi B2 tối đa mỗi request.
 *  5. Sinh báo cáo Markdown: quota-audit.md
 *
 * Exit code: 0 = không vi phạm; 1 = có vi phạm trần cứng; 2 = thiếu bundle.
 */

import { existsSync, readdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { gzipSync } from 'node:zlib';
import {
	ACCOUNT_DAILY_REQUEST_LIMIT,
	ALERT_THRESHOLDS,
	DEFAULT_DAILY_API_BUDGET,
	QUOTA_ENTER_THRESHOLDS,
	QUOTA_EXIT_THRESHOLDS,
	RELAX_CONSECUTIVE_CYCLES,
	MODE_COOLDOWN_MS,
	capabilitiesFor,
} from '../packages/core/src/index.js';

interface Finding {
	level: 'PASS' | 'WARN' | 'FAIL';
	area: string;
	detail: string;
}

const findings: Finding[] = [];

function add(level: Finding['level'], area: string, detail: string): void {
	findings.push({ level, area, detail });
	console.log(`${level.padEnd(4)}  ${area.padEnd(28)} ${detail}`);
}

// --------------------------------------------------------------- Workers Free
// Nguồn: Cloudflare docs "Workers platform limits" (đã đối chiếu 12/11).
const FREE_LIMITS = {
	requestsPerDay: 100_000,
	cpuTimeMs: 10,
	subrequests: 50,
	simultaneousOutbound: 6,
	cronTriggers: 5,
	memoryMiB: 128,
	workerSizeMiB: 3,
	startupMs: 1_000,
} as const;

function readToml(path: string): string {
	return existsSync(path) ? readFileSync(path, 'utf8') : '';
}

function tomlVar(text: string, key: string): string | null {
	const match = text.match(new RegExp(`^${key}\\s*=\\s*"([^"]*)"`, 'm'));
	return match?.[1] ?? null;
}

function tomlArray(text: string, key: string): string[] {
	const match = text.match(new RegExp(`^${key}\\s*=\\s*\\[([^\\]]*)\\]`, 'm'));
	if (!match?.[1]) return [];
	return [...match[1].matchAll(/"([^"]+)"/g)].map((item) => item[1] ?? '');
}

/** Lấy các route pattern từ mảng `routes = [ { pattern = "..." } ]` (nhiều dòng). */
function routePatterns(text: string): string[] {
	const block = text.match(/^routes\s*=\s*\[([\s\S]*?)\]/m);
	if (!block?.[1]) return [];
	return [...block[1].matchAll(/pattern\s*=\s*"([^"]+)"/g)].map((item) => item[1] ?? '');
}

// --------------------------------------------------------------- 1. bundle size
function auditBundle(label: string, path: string, limitMiB: number): void {
	if (!existsSync(path)) {
		add('WARN', `bundle:${label}`, `không tìm thấy ${path} — chạy npm run build trước`);
		return;
	}
	const raw = statSync(path).size;
	const gz = gzipSync(readFileSync(path)).length;
	const limit = limitMiB * 1024 * 1024;
	if (gz > limit) {
		add('FAIL', `bundle:${label}`, `gzip ${(gz / 1024).toFixed(1)} KiB > ${limitMiB} MiB`);
	} else {
		add('PASS', `bundle:${label}`, `gzip ${(gz / 1024).toFixed(1)} KiB ≤ ${limitMiB} MiB (raw ${(raw / 1024 / 1024).toFixed(2)} MiB)`);
	}
}

/**
 * Web worker là static-assets worker: script rất nhỏ, phần lớn dung lượng là
 * file tĩnh (assets) — tính theo giới hạn static assets, không tính vào 3 MiB script.
 */
function auditWebAssets(): void {
	const dist = 'apps/web/dist';
	if (!existsSync(dist)) {
		add('WARN', 'bundle:web', `không tìm thấy ${dist} — chạy npm run build trước`);
		return;
	}
	const files = globFiles(dist);
	const total = files.reduce((sum, file) => sum + statSync(file).size, 0);
	const biggest = files.reduce((max, file) => Math.max(max, statSync(file).size), 0);
	// Workers static assets (Free): 20.000 file, 25 MiB/file.
	if (files.length > 20_000) {
		add('FAIL', 'assets:web', `${files.length} file > 20.000 (Workers Free)`);
	} else {
		add('PASS', 'assets:web', `${files.length}/20.000 file, tổng ${(total / 1024 / 1024).toFixed(2)} MiB`);
	}
	if (biggest > 25 * 1024 * 1024) {
		add('FAIL', 'assets:web', `file lớn nhất ${(biggest / 1024 / 1024).toFixed(2)} MiB > 25 MiB`);
	} else {
		add('PASS', 'assets:web', `file lớn nhất ${(biggest / 1024).toFixed(1)} KiB ≤ 25 MiB`);
	}
	const entry = 'apps/web/src/worker.ts';
	if (existsSync(entry)) {
		const size = statSync(entry).size;
		add(
			size > 100 * 1024 ? 'WARN' : 'PASS',
			'bundle:web',
			`script entry ${(size / 1024).toFixed(1)} KiB (script riêng, không tính assets)`,
		);
	}
}

/** Liệt kê file đệ quy (thay glob phụ thuộc thư viện ngoài). */
function globFiles(root: string, prefix = ''): string[] {
	const out: string[] = [];
	for (const entry of readdirSync(`${root}/${prefix}`, { withFileTypes: true })) {
		const rel = prefix ? `${prefix}/${entry.name}` : entry.name;
		if (entry.isDirectory()) out.push(...globFiles(root, rel));
		else out.push(`${root}/${rel}`);
	}
	return out;
}

// --------------------------------------------------------------- 2. budget
function auditBudget(apiToml: string): { budget: number; limit: number; dailyCalls: number } {
	const budget = Number(tomlVar(apiToml, 'ALKCLOUD_DAILY_API_BUDGET') ?? DEFAULT_DAILY_API_BUDGET);
	const limit = Number(
		tomlVar(apiToml, 'ALKCLOUD_ACCOUNT_DAILY_REQUEST_LIMIT') ?? ACCOUNT_DAILY_REQUEST_LIMIT,
	);
	const dailyCalls = Number(tomlVar(apiToml, 'ALKCLOUD_DAILY_API_CALLS') ?? 0);

	if (budget > limit) {
		add('FAIL', 'quota:budget', `ALKCLOUD_DAILY_API_BUDGET (${budget}) > ACCOUNT_DAILY_REQUEST_LIMIT (${limit})`);
	} else {
		add(
			'PASS',
			'quota:budget',
			`budget ${budget.toLocaleString('vi-VN')} ≤ trần account ${limit.toLocaleString('vi-VN')} ` +
				`(${((budget / limit) * 100).toFixed(0)}%, còn ${(limit - budget).toLocaleString('vi-VN')} req cho worker khác)`,
		);
	}
	if (limit > FREE_LIMITS.requestsPerDay) {
		add('FAIL', 'quota:trần account', `${limit} > trần Workers Free ${FREE_LIMITS.requestsPerDay}/ngày`);
	} else {
		add('PASS', 'quota:trần account', `${limit} ≤ trần Workers Free ${FREE_LIMITS.requestsPerDay}/ngày`);
	}
	return { budget, limit, dailyCalls };
}

// --------------------------------------------------------------- 3. mode matrix
function auditModes(): void {
	const requiredAlways: Array<[string, keyof ReturnType<typeof capabilitiesFor>]> = [
		['complete upload', 'allowCompleteUpload'],
		['owner download', 'allowOwnerDownload'],
		['audit bắt buộc', 'allowMandatoryAudit'],
	];
	for (const mode of ['NORMAL', 'CONSERVE', 'READ_ONLY', 'EMERGENCY'] as const) {
		const caps = capabilitiesFor(mode);
		for (const [label, key] of requiredAlways) {
			if (caps[key]) {
				add('PASS', `mode:${mode}`, `${label} luôn được phép`);
			} else {
				add('FAIL', `mode:${mode}`, `${label} bị chặn — vi phạm tính toàn vẹn dữ liệu`);
			}
		}
	}
}

// --------------------------------------------------------------- 4. subrequests
function auditSubrequests(): void {
	// Số subrequest tối đa mỗi request API (gọi B2 + D1).
	// D1: 1 query = 1 subrequest (Workers Free: 50 subrequest/request).
	const cases: Array<{ path: string; b2: number; d1: number; note: string }> = [
		{ path: 'GET /api/v1/files', b2: 0, d1: 2, note: 'list + quota state' },
		{ path: 'GET /api/v1/files/:id/download', b2: 1, d1: 2, note: 'head + getObject' },
		{ path: 'GET /api/v1/public/share/download', b2: 1, d1: 3, note: 'share + file + getObject' },
		{ path: 'POST /api/v1/uploads', b2: 2, d1: 3, note: 'quota reserve + presign' },
		{ path: 'POST /api/v1/uploads/:id/complete', b2: 2, d1: 5, note: 'head/listParts + complete + file insert' },
		{ path: 'DELETE /api/v1/files/:id/purge', b2: 3, d1: 4, note: 'list versions + delete version + delete object' },
	];
	let worst = 0;
	for (const item of cases) {
		const total = item.b2 + item.d1;
		worst = Math.max(worst, total);
		const level = total > FREE_LIMITS.subrequests ? 'FAIL' : 'PASS';
		add(level, 'subrequest', `${item.path} ≈ ${total} (${item.note})`);
	}
	add(
		worst > FREE_LIMITS.subrequests ? 'FAIL' : 'PASS',
		'subrequest:tổng',
		`worst-case ${worst} ≤ ${FREE_LIMITS.subrequests} (Workers Free)`,
	);
}

// --------------------------------------------------------------- 5. cron
function auditCron(apiToml: string): void {
	const crons = tomlArray(apiToml, 'crons');
	if (crons.length === 0) {
		add('WARN', 'cron', 'không khai báo cron — cleanup/purge sẽ không chạy');
		return;
	}
	if (crons.length > FREE_LIMITS.cronTriggers) {
		add('FAIL', 'cron', `${crons.length} trigger > ${FREE_LIMITS.cronTriggers} (Workers Free)`);
	} else {
		add('PASS', 'cron', `${crons.length}/${FREE_LIMITS.cronTriggers} trigger — ${crons.join(', ')}`);
	}
}

// --------------------------------------------------------------- 6. thresholds
function auditThresholds(): void {
	for (const [mode, value] of Object.entries(QUOTA_ENTER_THRESHOLDS)) {
		const exit = QUOTA_EXIT_THRESHOLDS[mode as keyof typeof QUOTA_EXIT_THRESHOLDS];
		if (exit >= value) {
			add('FAIL', `threshold:${mode}`, `exit (${exit}) >= enter (${value}) — hysteresis vô hiệu`);
		} else {
			add('PASS', `threshold:${mode}`, `enter ${(value * 100).toFixed(0)}% > exit ${(exit * 100).toFixed(0)}%`);
		}
	}
	const maxAlert = Math.max(...ALERT_THRESHOLDS);
	if (maxAlert <= QUOTA_ENTER_THRESHOLDS.EMERGENCY) {
		add('PASS', 'threshold:alert', `ngưỡng cảnh báo tối đa ${(maxAlert * 100).toFixed(0)}% ≤ ngưỡng EMERGENCY`);
	} else {
		add('WARN', 'threshold:alert', `ngưỡng cảnh báo ${(maxAlert * 100).toFixed(0)}% > ngưỡng EMERGENCY`);
	}
	add(
		'PASS',
		'threshold:hysteresis',
		`hạ bậc cần ${RELAX_CONSECUTIVE_CYCLES} chu kỳ liên tiếp + cooldown ${MODE_COOLDOWN_MS / 60000} phút`,
	);
}

// --------------------------------------------------------------- report
function writeReport(budget: { budget: number; limit: number }): void {
	const pass = findings.filter((item) => item.level === 'PASS').length;
	const warn = findings.filter((item) => item.level === 'WARN').length;
	const fail = findings.filter((item) => item.level === 'FAIL').length;

	const md = [
		'# AlkCloud — Báo cáo audit Workers Free / quota',
		'',
		`- Sinh lúc: ${new Date().toISOString()}`,
		`- Kết quả: PASS=${pass} WARN=${warn} FAIL=${fail}`,
		'',
		'## Trần cứng Workers Free',
		'',
		'| Hạng mục | Trần |',
		'| :--- | ---: |',
		`| Requests / ngày | ${FREE_LIMITS.requestsPerDay.toLocaleString('vi-VN')} |`,
		`| CPU time / request | ${FREE_LIMITS.cpuTimeMs} ms |`,
		`| Subrequest / request | ${FREE_LIMITS.subrequests} |`,
		`| Đồng thời outbound | ${FREE_LIMITS.simultaneousOutbound} |`,
		`| Cron trigger | ${FREE_LIMITS.cronTriggers} |`,
		`| Bộ nhớ Worker | ${FREE_LIMITS.memoryMiB} MiB |`,
		`| Kích thước bundle | ${FREE_LIMITS.workerSizeMiB} MiB |`,
		'',
		'## Cấu hình quota',
		'',
		`- Budget API AlkCloud: **${budget.budget.toLocaleString('vi-VN')}** request/ngày`,
		`- Trần account khai báo: **${budget.limit.toLocaleString('vi-VN')}** request/ngày`,
		`- Phần còn cho worker khác trên cùng account: **${(budget.limit - budget.budget).toLocaleString('vi-VN')}** request/ngày`,
		'',
		'> Gateway `api-gateway` cùng account ⇒ **dùng chung** trần 100k/ngày. Không được coi budget AlkCloud là riêng biệt.',
		'',
		'## Ngưỡng degradation',
		'',
		'| Mode | Enter | Exit |',
		'| :--- | ---: | ---: |',
		...Object.entries(QUOTA_ENTER_THRESHOLDS).map(
			([mode, enter]) =>
				`| ${mode} | ${(enter * 100).toFixed(0)}% | ${((QUOTA_EXIT_THRESHOLDS as Record<string, number>)[mode]! * 100).toFixed(0)}% |`,
		),
		'',
		`Hạ bậc cần **${RELAX_CONSECUTIVE_CYCLES} chu kỳ** liên tiếp dưới ngưỡng exit + cooldown **${MODE_COOLDOWN_MS / 60000} phút**.`,
		'',
		'## Kết quả kiểm tra',
		'',
		'| Mức | Hạng mục | Chi tiết |',
		'| :--- | :--- | :--- |',
		...findings.map(
			(item) => `| ${item.level} | ${item.area} | ${item.detail.replace(/\|/g, '\\|')} |`,
		),
		'',
	].join('\n');
	writeFileSync('quota-audit.md', md);
	console.log('');
	console.log(`Kết quả: PASS=${pass} WARN=${warn} FAIL=${fail}`);
	console.log('Báo cáo: quota-audit.md');
}

// --------------------------------------------------------------- main
console.log('== AlkCloud — Audit Workers Free / quota ==');
const apiToml = readToml('apps/api/wrangler.toml');
const webToml = readToml('apps/web/wrangler.toml');
if (!apiToml) {
	console.error('FAIL — không đọc được apps/api/wrangler.toml');
	process.exit(2);
}

auditBundle('api', 'apps/api/dist/index.js', FREE_LIMITS.workerSizeMiB);
auditWebAssets();
const budget = auditBudget(apiToml);
auditModes();
auditSubrequests();
auditCron(apiToml);
auditThresholds();

// Route check: route API phải không trùng path của gateway.
const routes = routePatterns(apiToml);
if (routes.length === 0) {
	add('WARN', 'route:api', 'không có route — Worker sẽ không nhận request qua hostname');
} else {
	for (const pattern of routes) {
		if (pattern === 'api.alk.xx.kg/api/v1/*') {
			add('PASS', 'route:api', `${pattern} (không trùng /v1/* của gateway)`);
		} else {
			add('WARN', 'route:api', `${pattern} — cần owner xác nhận không trùng gateway`);
		}
	}
}
const webRoutes = routePatterns(webToml);
if (webRoutes.length === 0) {
	add('WARN', 'route:web', 'chưa có route cho cloud.alk.xx.kg — cần owner tạo DNS + route');
} else {
	add('PASS', 'route:web', webRoutes.join(', '));
}

writeReport(budget);
if (findings.some((item) => item.level === 'FAIL')) process.exitCode = 1;
