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

export function currentMode(state: UsageState | null): DegradationMode {
	return state?.mode ?? 'NORMAL';
}
