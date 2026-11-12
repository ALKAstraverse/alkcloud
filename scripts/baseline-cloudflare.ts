#!/usr/bin/env node
/**
 * Baseline Cloudflare cho AlkCloud — thu thập số liệu request/ngày.
 *
 *   node --import tsx scripts/baseline-cloudflare.ts --days 30
 *   node --import tsx scripts/baseline-cloudflare.ts --token-file ~/.cloudflare/token
 *
 * Token cần quyền: Account → Account Analytics → Read (và Zone Analytics Read tuỳ chọn).
 * Nếu thiếu quyền hoặc thiếu token, script báo NOT_CONFIGURED và exit code 2 —
 * KHÔNG dùng số 0 giả để báo "đã thu thập xong".
 */

import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { dirname, resolve } from 'node:path';

const args = process.argv.slice(2);

function argValue(name: string, fallback: string): string {
	const index = args.indexOf(`--${name}`);
	if (index >= 0 && args[index + 1]) return args[index + 1]!;
	return fallback;
}

const days = Number(argValue('days', '30'));
const accountId = argValue('account-id', process.env.CLOUDFLARE_ACCOUNT_ID ?? '');
const tokenFile = argValue('token-file', '');
const outputPath = resolve(argValue('out', 'baseline/workers-invocations.json'));

interface GraphQLResponse {
	data?: {
		viewer?: {
			accounts?: Array<{
				workersInvocationsAdaptive?: Array<{
					sum?: {
						requests?: number;
						errors?: number;
						subrequests?: number;
						cpuTimeUs?: number;
					};
					dimensions?: {
						date?: string;
						scriptName?: string;
						eventType?: string;
					};
				}>;
			}>;
		};
	};
	errors?: { message: string }[];
}

async function readToken(): Promise<string | null> {
	if (process.env.CLOUDFLARE_ANALYTICS_TOKEN) return process.env.CLOUDFLARE_ANALYTICS_TOKEN;
	if (!tokenFile) return null;
	try {
		const raw = readFileSync(tokenFile, 'utf8');
		const match = /CF_API_TOKEN=([^\s]+)/.exec(raw);
		return match?.[1] ?? null;
	} catch {
		return null;
	}
}

async function main(): Promise<void> {
	console.log('AlkCloud baseline — Cloudflare Workers invocations');
	console.log(`  window: ${days} ngày`);
	console.log(`  account: ${accountId || '(chưa cấu hình)'}`);

	const token = await readToken();
	if (!token) {
		console.error('\nNOT_CONFIGURED: chưa có token analytics.');
		console.error('  - Đặt CLOUDFLARE_ANALYTICS_TOKEN, hoặc');
		console.error('  - truyền --token-file <path> tới file chứa CF_API_TOKEN=...');
		process.exitCode = 2;
		return;
	}
	if (!accountId) {
		console.error('\nNOT_CONFIGURED: thiếu CLOUDFLARE_ACCOUNT_ID (account tag).');
		process.exitCode = 2;
		return;
	}

	const end = Date.now();
	const start = end - days * 24 * 60 * 60 * 1000;
	const query = `query($a: string!, $s: Time!, $e: Time!) {
		viewer {
			accounts(filter: {accountTag: $a}) {
				workersInvocationsAdaptive(
					limit: 10000,
					filter: {datetime_geq: $s, datetime_leq: $e}
				) {
					sum { requests errors subrequests cpuTimeUs }
					dimensions { date scriptName eventType }
				}
			}
		}
	}`;

	const response = await fetch('https://api.cloudflare.com/client/v4/graphql', {
		method: 'POST',
		headers: {
			Authorization: `Bearer ${token}`,
			'Content-Type': 'application/json',
		},
		body: JSON.stringify({
			query,
			variables: {
				a: accountId,
				s: new Date(start).toISOString(),
				e: new Date(end).toISOString(),
			},
		}),
	});

	if (!response.ok) {
		console.error(`\nGraphQL HTTP ${response.status}`);
		process.exitCode = 2;
		return;
	}

	const payload = (await response.json()) as GraphQLResponse;
	if (payload.errors?.length) {
		console.error('\nGraphQL errors:');
		for (const error of payload.errors) console.error(`  - ${error.message}`);
		console.error('\nCần token có quyền "Account Analytics → Read".');
		process.exitCode = 2;
		return;
	}

	const rows = payload.data?.viewer?.accounts?.[0]?.workersInvocationsAdaptive ?? [];
	if (rows.length === 0) {
		console.warn('\nKhông có dữ liệu trong khoảng thời gian yêu cầu.');
	}

	const byDay = new Map<string, { requests: number; errors: number; subrequests: number; cpuTimeUs: number }>();
	const byScript = new Map<string, number>();
	for (const row of rows) {
		const date = row.dimensions?.date ?? 'unknown';
		const current = byDay.get(date) ?? { requests: 0, errors: 0, subrequests: 0, cpuTimeUs: 0 };
		current.requests += Number(row.sum?.requests ?? 0);
		current.errors += Number(row.sum?.errors ?? 0);
		current.subrequests += Number(row.sum?.subrequests ?? 0);
		current.cpuTimeUs += Number(row.sum?.cpuTimeUs ?? 0);
		byDay.set(date, current);

		const script = row.dimensions?.scriptName ?? 'unknown';
		byScript.set(script, (byScript.get(script) ?? 0) + Number(row.sum?.requests ?? 0));
	}

	const daily = [...byDay.entries()].sort(([a], [b]) => a.localeCompare(b));
	const values = daily.map(([, value]) => value.requests).sort((a, b) => a - b);
	const percentile = (p: number): number => {
		if (values.length === 0) return 0;
		const index = Math.min(values.length - 1, Math.ceil((p / 100) * values.length) - 1);
		return values[Math.max(0, index)] ?? 0;
	};

	const summary = {
		generatedAt: new Date().toISOString(),
		windowDays: days,
		accountId,
		rows: rows.length,
		daily,
		byScript: Object.fromEntries([...byScript.entries()].sort((a, b) => b[1] - a[1])),
		percentiles: {
			p50: percentile(50),
			p95: percentile(95),
			p99: percentile(99),
			max: values[values.length - 1] ?? 0,
			mean: values.length ? values.reduce((sum, value) => sum + value, 0) / values.length : 0,
		},
		note:
			'workersInvocationsAdaptive là BETA + adaptive sampling => số liệu là UỐC LƯỢNG. ' +
			'Phải đối chiếu ≥3 ngày với Workers Logs (exact) trước khi chốt hard cap.',
	};

	mkdirSync(dirname(outputPath), { recursive: true });
	writeFileSync(outputPath, `${JSON.stringify(summary, null, 2)}\n`);

	console.log(`\nĐã ghi ${outputPath}`);
	console.log(`  p50=${summary.percentiles.p50} p95=${summary.percentiles.p95} p99=${summary.percentiles.p99}`);
	console.log('\nTop scripts:');
	for (const [script, count] of Object.entries(summary.byScript).slice(0, 10)) {
		console.log(`  ${String(count).padStart(8)}  ${script}`);
	}
}

void main();
