export function nowIso(): string {
	return new Date().toISOString();
}

export function isoFromMs(ms: number): string {
	return new Date(ms).toISOString();
}

export function msFromIso(iso: string): number {
	return new Date(iso).getTime();
}

export function addDays(iso: string, days: number): string {
	return new Date(msFromIso(iso) + days * 24 * 60 * 60 * 1000).toISOString();
}

export function addHours(iso: string, hours: number): string {
	return new Date(msFromIso(iso) + hours * 60 * 60 * 1000).toISOString();
}

export function addSeconds(iso: string, seconds: number): string {
	return new Date(msFromIso(iso) + seconds * 1000).toISOString();
}

export function isExpired(iso: string, nowMs = Date.now()): boolean {
	return msFromIso(iso) <= nowMs;
}

/** Ngày UTC của timestamp — dùng để gom bộ đếm quota theo ngày reset 00:00 UTC. */
export function utcDateKey(ms = Date.now()): string {
	return new Date(ms).toISOString().slice(0, 10);
}
