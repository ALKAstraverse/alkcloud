#!/usr/bin/env node
/**
 * WS-H — Mô hình chi phí (cost model).
 *
 * LOẠI: READ_ONLY (tính toán thuần, không gọi API, không ghi tài nguyên).
 *
 * Vì sao cần:
 * AlkCloud là dịch vụ **cá nhân, 1 owner**. "Chi phí" ở đây không phải doanh thu
 * mà là: **hành động của owner có làm vượt hạn mức miễn phí nào không?**
 * Ba hạn mức có thể vỡ:
 *   1. Cloudflare Workers Free: 100k request/ngày — **dùng CHUNG account** với
 *      gateway `api-gateway` (đã chạy production) ⇒ vỡ hạn mức là vỡ của cả account.
 *   2. B2: $6.95/TB/tháng, 10GB free, egress free ≤ 3× stored.
 *   3. Cloudflare D1: 5M row read/ngày, 100k row written/ngày (Free).
 *
 * Mô hình này **dự kiến** (projection), dựa trên giả định DO OWNER XÁC NHẬN.
 * Script không đọc số liệu thật của Cloudflare ⇒ mọi con số đầu ra là
 * "NẾU vậy thì ra sao", không phải "đang tốn bao nhiêu".
 *
 * Dùng:
 *   npm run cost                       # kịch bản mặc định
 *   npm run cost -- --json out.json    # ghi kết quả JSON
 *   npm run cost -- --stored-gb 500 --requests-day 40000
 */
import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));

// ── Giá & hạn mức (nguồn: docs/28-COST-MODEL.md §2, kiểm tra lại trước khi dùng) ──
export const PRICING = {
	/** B2: $/TB/tháng (nhuộm 1TB = 1024GB). */
	b2PerTbMonth: 6.95,
	/** B2 free tier: GB lưu trữ miễn phí. */
	b2FreeGb: 10,
	/** Egress miễn phí = số lần dung lượng đã lưu (B2: egress free ≤ 3× stored). */
	b2EgressFreeMultiplier: 3,
	/** B2 egress: $/GB (ngoài phần free). */
	b2EgressPerGb: 0.09,
	/** Cloudflare Workers Free: request/ngày cho CẢ account. */
	workersFreeRequestsPerDay: 100_000,
	/** D1 Free: dòng đọc/ngày. */
	d1FreeRowsReadPerDay: 5_000_000,
	/** D1 Free: dòng ghi/ngày. */
	d1FreeRowsWrittenPerDay: 100_000,
	/** D1 Free: dung lượng (GB). */
	d1FreeStorageGb: 5,
} as const;

export interface Scenario {
	name: string;
	/** Dung lượng lưu trữ (GB). */
	storedGb: number;
	/** Egress/tháng (GB) — tải xuống qua B2. */
	egressGbMonth: number;
	/** Request API/ngày của AlkCloud (chưa trừ gateway). */
	alkRequestsPerDay: number;
	/** Request/ngày của gateway `api-gateway` (đã chạy production, dùng chung account). */
	gatewayRequestsPerDay: number;
	/** Dòng D1 đọc/ngày của AlkCloud. */
	d1RowsReadPerDay: number;
	/** Dòng D1 ghi/ngày của AlkCloud. */
	d1RowsWrittenPerDay: number;
}

export interface ScenarioResult {
	scenario: Scenario;
	b2: {
		storageGb: number;
		billableGb: number;
		storageCostMonth: number;
		egressGb: number;
		freeEgressGb: number;
		billableEgressGb: number;
		egressCostMonth: number;
		totalMonth: number;
	};
	cloudflare: {
		totalRequestsPerDay: number;
		requestsFreeLimit: number;
		requestsHeadroom: number;
		requestsOverLimit: boolean;
		d1RowsReadPerDay: number;
		d1RowsReadOverLimit: boolean;
		d1RowsWrittenPerDay: number;
		d1RowsWrittenOverLimit: boolean;
	};
	notes: string[];
}

const GB_PER_TB = 1024;

export function evaluateScenario(scenario: Scenario): ScenarioResult {
	const notes: string[] = [];

	// ── B2 ──────────────────────────────────────────────────────────────
	const billableGb = Math.max(0, scenario.storedGb - PRICING.b2FreeGb);
	const storageCostMonth = (billableGb / GB_PER_TB) * PRICING.b2PerTbMonth;

	const freeEgressGb = scenario.storedGb * PRICING.b2EgressFreeMultiplier;
	const billableEgressGb = Math.max(0, scenario.egressGbMonth - freeEgressGb);
	const egressCostMonth = billableEgressGb * PRICING.b2EgressPerGb;

	if (scenario.storedGb <= PRICING.b2FreeGb) {
		notes.push('Dung lượng nằm trong 10GB free của B2 ⇒ chi phí lưu trữ = $0.');
	}
	if (billableEgressGb === 0) {
		notes.push(
			`Egress ${scenario.egressGbMonth}GB/tháng ≤ free ${freeEgressGb.toFixed(0)}GB (= 3× stored) ⇒ không phí egress.`,
		);
	}

	// ── Cloudflare ──────────────────────────────────────────────────────
	const totalRequestsPerDay = scenario.alkRequestsPerDay + scenario.gatewayRequestsPerDay;
	const requestsHeadroom = PRICING.workersFreeRequestsPerDay - totalRequestsPerDay;
	const requestsOverLimit = totalRequestsPerDay > PRICING.workersFreeRequestsPerDay;
	if (requestsOverLimit) {
		notes.push(
			`VƯỢT hạn mức Workers Free: ${totalRequestsPerDay.toLocaleString('vi-VN')} req/ngày > ${PRICING.workersFreeRequestsPerDay.toLocaleString('vi-VN')} ⇒ phải nâng gói hoặc giảm lưu lượng.`,
		);
	} else {
		notes.push(
			`Còn ${requestsHeadroom.toLocaleString('vi-VN')} request/ngày trước khi vỡ hạn mức Workers (dùng chung account với gateway).`,
		);
	}
	if (scenario.d1RowsReadPerDay > PRICING.d1FreeRowsReadPerDay) {
		notes.push(
			`VƯỢT hạn mức D1 rows read: ${scenario.d1RowsReadPerDay.toLocaleString('vi-VN')} > ${PRICING.d1FreeRowsReadPerDay.toLocaleString('vi-VN')}.`,
		);
	}
	if (scenario.d1RowsWrittenPerDay > PRICING.d1FreeRowsWrittenPerDay) {
		notes.push(
			`VƯỢT hạn mức D1 rows written: ${scenario.d1RowsWrittenPerDay.toLocaleString('vi-VN')} > ${PRICING.d1FreeRowsWrittenPerDay.toLocaleString('vi-VN')}.`,
		);
	}
	if (scenario.d1RowsWrittenPerDay > PRICING.d1FreeRowsWrittenPerDay * 0.5) {
		notes.push(
			'Cảnh báo: D1 rows written đã dùng > 50% hạn mức — cân nhắc ghi theo batch (đã làm cho usage_daily, còn audit log thì cần retention).',
		);
	}

	return {
		scenario,
		b2: {
			storageGb: scenario.storedGb,
			billableGb,
			storageCostMonth,
			egressGb: scenario.egressGbMonth,
			freeEgressGb,
			billableEgressGb,
			egressCostMonth,
			totalMonth: storageCostMonth + egressCostMonth,
		},
		cloudflare: {
			totalRequestsPerDay,
			requestsFreeLimit: PRICING.workersFreeRequestsPerDay,
			requestsHeadroom,
			requestsOverLimit,
			d1RowsReadPerDay: scenario.d1RowsReadPerDay,
			d1RowsReadOverLimit: scenario.d1RowsReadPerDay > PRICING.d1FreeRowsReadPerDay,
			d1RowsWrittenPerDay: scenario.d1RowsWrittenPerDay,
			d1RowsWrittenOverLimit: scenario.d1RowsWrittenPerDay > PRICING.d1FreeRowsWrittenPerDay,
		},
		notes,
	};
}

/** Kịch bản mặc định — dựa trên hành vi 1 owner thực tế. */
export const DEFAULT_SCENARIOS: Scenario[] = [
	{
		name: 'Nhẹ — 1 owner, 5GB, dùng hằng ngày',
		storedGb: 5,
		egressGbMonth: 20,
		alkRequestsPerDay: 500,
		gatewayRequestsPerDay: 5_000,
		d1RowsReadPerDay: 20_000,
		d1RowsWrittenPerDay: 2_000,
	},
	{
		name: 'Vừa — 1 owner, 50GB, có chia sẻ',
		storedGb: 50,
		egressGbMonth: 200,
		alkRequestsPerDay: 2_000,
		gatewayRequestsPerDay: 5_000,
		d1RowsReadPerDay: 100_000,
		d1RowsWrittenPerDay: 10_000,
	},
	{
		name: 'Nặng — 500GB, tải nhiều',
		storedGb: 500,
		egressGbMonth: 2_000,
		alkRequestsPerDay: 10_000,
		gatewayRequestsPerDay: 5_000,
		d1RowsReadPerDay: 500_000,
		d1RowsWrittenPerDay: 30_000,
	},
	{
		name: 'Vỡ — 2TB + 50k req/ngày (trần thiết kế)',
		storedGb: 2_048,
		egressGbMonth: 20_000,
		alkRequestsPerDay: 50_000,
		gatewayRequestsPerDay: 5_000,
		d1RowsReadPerDay: 2_000_000,
		d1RowsWrittenPerDay: 80_000,
	},
];

function parseArgs(): { jsonPath: string | null; overrides: Partial<Scenario> } {
	const args = process.argv.slice(2);
	const jsonIndex = args.indexOf('--json');
	const jsonPath = jsonIndex >= 0 ? (args[jsonIndex + 1] ?? null) : null;
	const overrides: Partial<Scenario> = {};
	const numberFlag = (name: string, key: keyof Scenario) => {
		const index = args.indexOf(name);
		if (index >= 0 && args[index + 1]) overrides[key] = Number(args[index + 1]) as never;
	};
	numberFlag('--stored-gb', 'storedGb');
	numberFlag('--egress-gb', 'egressGbMonth');
	numberFlag('--requests-day', 'alkRequestsPerDay');
	numberFlag('--gateway-requests-day', 'gatewayRequestsPerDay');
	numberFlag('--d1-read', 'd1RowsReadPerDay');
	numberFlag('--d1-write', 'd1RowsWrittenPerDay');
	return { jsonPath, overrides };
}

function main(): void {
	const { jsonPath, overrides } = parseArgs();
	const scenarios: Scenario[] = DEFAULT_SCENARIOS.map((scenario) => ({
		...scenario,
		...overrides,
		name:
			Object.keys(overrides).length > 0
				? `${scenario.name} (đè tham số: ${Object.entries(overrides)
						.map(([key, value]) => `${key}=${value}`)
						.join(', ')})`
				: scenario.name,
	}));

	const results = scenarios.map(evaluateScenario);

	console.log('');
	console.log('  MÔ HÌNH CHI PHÍ — AlkCloud (1 owner)');
	console.log('  ' + '─'.repeat(88));
	for (const result of results) {
		const { b2, cloudflare, scenario } = result;
		console.log('');
		console.log(`  ${scenario.name}`);
		console.log(
			`    B2: ${scenario.storedGb}GB lưu trữ (billable ${b2.billableGb}GB) + ${scenario.egressGbMonth}GB egress/tháng`,
		);
		console.log(
			`        lưu trữ $${b2.storageCostMonth.toFixed(3)}/tháng · egress $${b2.egressCostMonth.toFixed(3)}/tháng (free ${b2.freeEgressGb.toFixed(0)}GB)`,
		);
		console.log(`        TỔNG B2: $${b2.totalMonth.toFixed(3)}/tháng`);
		console.log(
			`    Cloudflare: ${cloudflare.totalRequestsPerDay.toLocaleString('vi-VN')} req/ngày (AlkCloud ${scenario.alkRequestsPerDay.toLocaleString('vi-VN')} + gateway ${scenario.gatewayRequestsPerDay.toLocaleString('vi-VN')})`,
		);
		console.log(
			`        headroom ${cloudflare.requestsHeadroom.toLocaleString('vi-VN')} req/ngày${cloudflare.requestsOverLimit ? '  ✗ VƯỢT' : '  ✓'}`,
		);
		console.log(
			`    D1: đọc ${scenario.d1RowsReadPerDay.toLocaleString('vi-VN')}/ngày${cloudflare.d1RowsReadOverLimit ? ' ✗' : ' ✓'} · ghi ${scenario.d1RowsWrittenPerDay.toLocaleString('vi-VN')}/ngày${cloudflare.d1RowsWrittenOverLimit ? ' ✗' : ' ✓'}`,
		);
		for (const note of result.notes) console.log(`    • ${note}`);
	}
	console.log('');
	console.log('  Lưu ý: đây là DỰ KIẾN theo giả định, KHÔNG phải hóa đơn thật.');
	console.log('  Giá/hạn mức có thể đổi — kiểm tra lại trước khi ra quyết định.');
	console.log('');

	if (jsonPath) {
		mkdirSync(dirname(resolve(jsonPath)), { recursive: true });
		writeFileSync(
			resolve(jsonPath),
			`${JSON.stringify(
				{
					generatedAt: new Date().toISOString(),
					pricing: PRICING,
					results,
				},
				null,
				2,
			)}\n`,
		);
		console.log(`  Đã ghi: ${resolve(jsonPath)}`);
		console.log('');
	}
}

main();
