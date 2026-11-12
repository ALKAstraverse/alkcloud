import type { Database } from '@alkcloud/db';
import type { ObjectStorage } from '@alkcloud/storage';
import type { DegradationMode, UsageState } from '@alkcloud/core';
import type { ResolvedConfig } from './env.js';

export interface AppContext {
	db: Database;
	storage: ObjectStorage;
	config: ResolvedConfig;
	now(): Date;
}

/**
 * Bộ đếm API call theo ngày (SEC-13).
 *
 * `usage_daily.api_calls` trước đây KHÔNG BAO GIỜ được ghi ⇒ nửa "budget" của
 * cơ chế degradation luôn bằng 0 ⇒ `evaluateQuota` không bao giờ hạ bậc.
 *
 * Ghi 1 D1 row cho MỖI request là quá đắt (Workers Free: 100k rows/day, cùng
 * hạn mức với số request) ⇒ đếm trong RAM của isolate rồi GỘP (batch) mỗi
 * `USAGE_FLUSH_THRESHOLD` request. Sai số tối đa = số request chưa flush khi
 * isolate bị thu hồi — chấp nhận được vì đây là ước lượng, không phải hard cap.
 */
export const USAGE_FLUSH_THRESHOLD = 20;

interface UsageCounter {
	pending: number;
	day: string;
}

const QUOTA_STATE_KEY = 'quota_state';

interface CachedQuota {
	state: UsageState;
	fetchedAtMs: number;
}

// Cache theo từng `Database` instance (WeakMap) thay vì biến module-level:
// tránh rò rỉ state giữa nhiều app instance / test harness trong cùng process.
const quotaCacheByDb = new WeakMap<Database, CachedQuota>();

export async function readQuotaState(db: Database, ttlSeconds: number, nowMs = Date.now()): Promise<UsageState | null> {
	const cached = quotaCacheByDb.get(db);
	if (cached && nowMs - cached.fetchedAtMs < ttlSeconds * 1000) {
		return cached.state;
	}
	const state = await db.getSystemState<UsageState>(QUOTA_STATE_KEY);
	if (state) {
		quotaCacheByDb.set(db, { state, fetchedAtMs: nowMs });
	}
	return state;
}

export async function writeQuotaState(db: Database, state: UsageState, now: string): Promise<void> {
	await db.setSystemState(QUOTA_STATE_KEY, state, now);
	quotaCacheByDb.set(db, { state, fetchedAtMs: Date.now() });
}

export function invalidateQuotaCache(db: Database): void {
	quotaCacheByDb.delete(db);
}

const usageCounterByDb = new WeakMap<Database, UsageCounter>();

/** Ghi nhận 1 API call. Trả về true nếu đã tới ngưỡng flush (caller ghi D1). */
export function recordApiCall(db: Database, day: string): boolean {
	const counter = usageCounterByDb.get(db) ?? { pending: 0, day };
	if (counter.day !== day) {
		counter.day = day;
		counter.pending = 0;
	}
	counter.pending += 1;
	usageCounterByDb.set(db, counter);
	return counter.pending >= USAGE_FLUSH_THRESHOLD;
}

/** Lấy số request đang chờ ghi + reset bộ đếm. */
export function takePendingApiCalls(db: Database): number {
	const counter = usageCounterByDb.get(db);
	if (!counter || counter.pending === 0) return 0;
	const pending = counter.pending;
	counter.pending = 0;
	return pending;
}

export function currentMode(state: UsageState | null): DegradationMode {
	return state?.mode ?? 'NORMAL';
}
