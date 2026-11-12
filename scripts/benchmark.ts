#!/usr/bin/env node
/**
 * WS-G — Benchmark hiệu năng (reproducible).
 *
 * LOẠI: READ_ONLY (đọc + ghi vào bộ nhớ/tệp tạm của máy chạy benchmark).
 * KHÔNG đụng production, KHÔNG gọi Cloudflare/B2 thật.
 *
 * Vì sao cần:
 * Workers Free có CPU **10ms/request** — trần cứng, không phải mục tiêu có thể
 * đàm phán. Benchmark local đo **chi phí tương đối** của từng đường code
 * (bốn phần trăm request so với trước) để phát hiện hồi quy trước khi deploy.
 *
 * CÁCH ĐỌC KẾT QUẢ (quan trọng — tránh tự lừa mình):
 * - Số liệu CPU **không** phản ánh đúng CPU của Cloudflare Workers (V8 isolate
 *   khác, I/O thật thay vì mock).
 * - Benchmark chạy trên host Ubuntu 24.04, Node v22 ⇒ chỉ dùng để **so sánh
 *   tương đối** giữa các lần chạy, không dùng để cam kết SLA.
 * - Ngưỡng PASS/FAIL trong `benchmarks/baseline.json` là **ngân sách nội bộ**
 *   (regression guard), không phải SLA của Cloudflare.
 *
 * Cách dùng:
 *   npm run bench                       # chạy và so với baseline
 *   npm run bench -- --json out.json    # ghi kết quả ra file
 *   npm run bench -- --update-baseline  # cập nhật baseline (cần owner review)
 */
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Database, runMigrations } from '@alkcloud/db';
import { SqliteDriver } from '@alkcloud/db/sqlite';
import { MockObjectStorage } from '@alkcloud/storage';
import { createApp } from '../apps/api/src/app.js';
import { resolveConfig } from '../apps/api/src/env.js';
import { loadMigrationFiles } from '../packages/db/test/helpers.js';

const HERE = dirname(fileURLToPath(import.meta.url));
const BASELINE_PATH = resolve(HERE, '../benchmarks/baseline.json');

const ORIGIN = 'https://cloud.alk.xx.kg';
const API = 'https://api.alk.xx.kg/api/v1';
const SETUP_TOKEN = 'setup-token-0123456789abcdef';
const AUTH_KEY = 'client-argon2id-output-key-0001';

interface BenchResult {
	name: string;
	iterations: number;
	totalMs: number;
	meanUs: number;
	p95Us: number;
	requestsPerSecond: number;
}

interface BenchReport {
	generatedAt: string;
	node: string;
	platform: string;
	results: BenchResult[];
	baseline?: unknown;
	verdict: 'PASS' | 'FAIL' | 'NO_BASELINE';
	failures: string[];
}

/** Ngân sách nội bộ (µms/request) — regression guard, KHÔNG phải SLA. */
const BUDGET_US: Record<string, number> = {
	'GET /files (root, 50 file)': 8000,
	'GET /system/usage': 6000,
	'POST /uploads (presign)': 8000,
	'GET /audit (100 events)': 8000,
	'POST /auth/login (verify)': 6000,
	'GET /files/:id/download (proxy)': 6000,
};

function percentile(values: number[], p: number): number {
	if (values.length === 0) return 0;
	const sorted = [...values].sort((a, b) => a - b);
	const index = Math.min(sorted.length - 1, Math.max(0, Math.ceil((p / 100) * sorted.length) - 1));
	return sorted[index]!;
}

/**
 * Đo một đường code.
 *
 * Vì sao nhiều round + trung vị: host chạy chung với nhiều service khác ⇒ p95
 * của MỘT lần chạy rất dễ nhiễu (lần chạy trước/thứ sau lệch nhau 2–3×).
 * Quy ước chuẩn (như Criterion): chạy N round, lấy **trung vị** của các round
 * ⇒ phản ánh xu hướng thay vì nhiễu của máy.
 */
const ROUNDS = Number(process.env.BENCH_ROUNDS ?? 3);

function median(values: number[]): number {
	if (values.length === 0) return 0;
	const sorted = [...values].sort((a, b) => a - b);
	const mid = Math.floor(sorted.length / 2);
	return sorted.length % 2 === 0 ? (sorted[mid - 1]! + sorted[mid]!) / 2 : sorted[mid]!;
}

async function measure(name: string, iterations: number, fn: (index: number) => Promise<void>): Promise<BenchResult> {
	// Warm-up: loại bỏ ảnh hưởng JIT + lazy init (zod schema compile…).
	for (let index = 0; index < Math.min(20, iterations); index++) await fn(index);

	const roundMeans: number[] = [];
	const roundP95: number[] = [];
	const roundRps: number[] = [];
	for (let round = 0; round < ROUNDS; round++) {
		const samples: number[] = [];
		const start = performance.now();
		for (let index = 0; index < iterations; index++) {
			const t0 = performance.now();
			await fn(index);
			// `performance.now()` trả ms ⇒ chuyển sang µs ngay để p95 và mean cùng đơn vị.
			samples.push((performance.now() - t0) * 1000);
		}
		const totalMs = performance.now() - start;
		roundMeans.push((totalMs / iterations) * 1000);
		roundP95.push(percentile(samples, 95));
		roundRps.push(iterations / (totalMs / 1000));
	}

	return {
		name,
		iterations: iterations * ROUNDS,
		totalMs: Number((roundMeans.reduce((sum, value) => sum + value, 0) / ROUNDS).toFixed(3)),
		meanUs: Number(median(roundMeans).toFixed(1)),
		p95Us: Number(median(roundP95).toFixed(1)),
		requestsPerSecond: Number(median(roundRps).toFixed(1)),
	};
}

async function main(): Promise<void> {
	const args = process.argv.slice(2);
	const updateBaseline = args.includes('--update-baseline');
	const jsonIndex = args.indexOf('--json');
	const jsonPath = jsonIndex >= 0 ? args[jsonIndex + 1] : null;

	const driver = new SqliteDriver(':memory:');
	await runMigrations(driver, loadMigrationFiles());
	const db = new Database(driver);
	const storage = new MockObjectStorage();
	const env = {
		ALKCLOUD_ALLOWED_ORIGINS: ORIGIN,
		ALKCLOUD_PUBLIC_URL: 'https://cloud.alk.xx.kg',
		ALKCLOUD_API_URL: API,
		AUTH_PEPPER: 'test-pepper-value-0123456789',
		BOOTSTRAP_SETUP_TOKEN: SETUP_TOKEN,
		ENVIRONMENT: 'benchmark',
	} as never;
	const config = resolveConfig(env);
	// Override rate limit: benchmark cần hàng trăm lần login, còn policy thật
	// là 5/15′ (IP) và 30/15′ (tài khoản). Override CHỈ có thể đặt qua code
	// (`createApp`) — không có đường nào trong production đọc nó.
	const app = createApp({
		db,
		storage,
		config,
		rateLimits: {
			login: { limit: 100_000, windowMs: 60_000 },
			loginAccount: { limit: 100_000, windowMs: 60_000 },
		},
	});

	let cookie = '';
	let csrf = '';
	const request = async (path: string, options: Record<string, unknown> = {}) => {
		const headers: Record<string, string> = {
			origin: ORIGIN,
			'x-alkcloud-csrf': csrf,
			...(cookie ? { cookie } : {}),
			...(options.body !== undefined ? { 'content-type': 'application/json' } : {}),
			...((options.headers as Record<string, string>) ?? {}),
		};
		return app.fetch(
			new Request(`${API}${path}`, {
				method: (options.method as string) ?? 'GET',
				headers,
				body: options.body === undefined ? undefined : JSON.stringify(options.body),
			}),
			env,
			{ waitUntil: () => undefined, passThroughOnException: () => undefined } as never,
		);
	};

	// Bootstrap + seed 50 file.
	const bootstrap = await request('/auth/bootstrap', {
		method: 'POST',
		body: {
			setupToken: SETUP_TOKEN,
			email: 'owner@alkcloud.test',
			authKey: AUTH_KEY,
			authVerifierSalt: 'salt-12345678',
			authParams: 'params-12345678',
		},
	});
	if (bootstrap.status !== 201) throw new Error(`bootstrap thất bại: ${bootstrap.status}`);
	cookie = (bootstrap.headers.get('set-cookie') ?? '').split(';')[0] ?? '';
	csrf = ((await bootstrap.json()) as { session: { csrfToken: string } }).session.csrfToken;

	const owner = await db.getOwner();
	const now = '2026-01-15T10:00:00.000Z';
	const fileIds: string[] = [];
	for (let index = 0; index < 50; index++) {
		const id = `fil_bench_${index}`;
		fileIds.push(id);
		const objectKey = `objects/${id}/rev`;
		await db.createFile({
			id,
			folderId: null,
			name: `bench-${index}.txt`,
			size: 1024,
			contentType: 'text/plain',
			objectKey,
			revisionId: 'rev',
			etag: `etag-${index}`,
			checksumSha256: null,
			now,
		});
		storage.putObject(objectKey, {
			size: 1024,
			contentType: 'text/plain',
			etag: `etag-${index}`,
			body: new TextEncoder().encode('x'.repeat(1024)),
		});
	}
	void owner;

	const results: BenchResult[] = [];

	results.push(
		await measure('GET /files (root, 50 file)', 300, async () => {
			const response = await request('/files');
			if (response.status !== 200) throw new Error(`GET /files → ${response.status}`);
		}),
	);

	results.push(
		await measure('GET /system/usage', 300, async () => {
			const response = await request('/system/usage');
			if (response.status !== 200) throw new Error(`GET /system/usage → ${response.status}`);
		}),
	);

	// Vòng đo CHỈ tính thời gian của POST /uploads. Việc huỷ session (cleanup)
	// diễn ra NGOÀI vòng đo, nếu không sẽ đo nhầm 2 request thay vì 1.
	const uploadSessionIds: string[] = [];
	results.push(
		await measure('POST /uploads (presign)', 200, async () => {
			const response = await request('/uploads', {
				method: 'POST',
				body: { fileName: 'bench.txt', contentType: 'text/plain', totalSize: 1024, checksumSha256: null },
			});
			if (response.status !== 201) throw new Error(`POST /uploads → ${response.status}`);
			const payload = (await response.json()) as { uploadSessionId: string };
			uploadSessionIds.push(payload.uploadSessionId);
		}),
	);
	for (const sessionId of uploadSessionIds) {
		await request(`/uploads/${sessionId}`, { method: 'DELETE' });
	}

	results.push(
		await measure('GET /audit (100 events)', 200, async () => {
			const response = await request('/system/audit?limit=100');
			if (response.status !== 200) throw new Error(`GET /audit → ${response.status}`);
		}),
	);

	results.push(
		await measure('POST /auth/login (verify)', 100, async () => {
			const response = await request('/auth/login', {
				method: 'POST',
				body: { email: 'owner@alkcloud.test', authKey: AUTH_KEY },
			});
			if (response.status !== 200) throw new Error(`POST /auth/login → ${response.status}`);
		}),
	);

	results.push(
		await measure('GET /files/:id/download (proxy)', 200, async () => {
			const response = await request(`/files/${fileIds[0]}/download`);
			if (response.status !== 200) throw new Error(`GET /download → ${response.status}`);
			await response.arrayBuffer();
		}),
	);

	// ── Kết quả ──────────────────────────────────────────────────────────
	const failures: string[] = [];
	for (const result of results) {
		const budget = BUDGET_US[result.name];
		if (budget !== undefined && result.p95Us > budget) {
			failures.push(`${result.name}: p95 ${result.p95Us}µs > ngân sách ${budget}µs`);
		}
	}

	let baseline: unknown = null;
	try {
		baseline = JSON.parse(readFileSync(BASELINE_PATH, 'utf8'));
	} catch {
		baseline = null;
	}

	const report: BenchReport = {
		generatedAt: new Date().toISOString(),
		node: process.version,
		platform: `${process.platform}/${process.arch}`,
		results,
		baseline,
		verdict: failures.length > 0 ? 'FAIL' : baseline ? 'PASS' : 'NO_BASELINE',
		failures,
	};

	if (updateBaseline) {
		mkdirSync(dirname(BASELINE_PATH), { recursive: true });
		writeFileSync(
			BASELINE_PATH,
			`${JSON.stringify(
				{
					generatedAt: report.generatedAt,
					node: report.node,
					platform: report.platform,
					budgetsUs: BUDGET_US,
					results: results.map((result) => ({ name: result.name, meanUs: result.meanUs, p95Us: result.p95Us })),
				},
				null,
				2,
			)}\n`,
		);
		console.log(`Đã cập nhật baseline: ${BASELINE_PATH}`);
	}

	if (jsonPath) {
		mkdirSync(dirname(resolve(jsonPath)), { recursive: true });
		writeFileSync(resolve(jsonPath), `${JSON.stringify(report, null, 2)}\n`);
		console.log(`Đã ghi báo cáo: ${resolve(jsonPath)}`);
	}

	// ── In kết quả ───────────────────────────────────────────────────────
	console.log('');
	console.log('  Benchmark      n         mean(µs)     p95(µs)      req/s');
	console.log('  ' + '─'.repeat(64));
	for (const result of results) {
		console.log(
			`  ${result.name.padEnd(30)} ${String(result.iterations).padStart(4)} ${result.meanUs
				.toFixed(1)
				.padStart(10)} ${result.p95Us.toFixed(1).padStart(12)} ${result.requestsPerSecond
				.toFixed(0)
				.padStart(10)}`,
		);
	}
	console.log('');
	if (failures.length > 0) {
		console.log('  ✗ VƯỢT NGÂN SÁCH:');
		for (const failure of failures) console.log(`    - ${failure}`);
	} else {
		console.log('  ✓ Tất cả đường đo nằm trong ngân sách nội bộ.');
	}
	console.log('');
	console.log('  Lưu ý: số liệu LOCAL để so sánh tương đối — KHÔNG phải CPU Workers');
	console.log('  và KHÔNG phải SLA. Ngân sách là regression guard nội bộ.');
	console.log('');

	if (failures.length > 0) process.exitCode = 1;
}

main().catch((error: unknown) => {
	console.error('Benchmark lỗi:', error instanceof Error ? error.message : String(error));
	process.exitCode = 1;
});
