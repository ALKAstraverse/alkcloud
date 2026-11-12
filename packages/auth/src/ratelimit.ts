export interface RateLimitDecision {
	allowed: boolean;
	remaining: number;
	retryAfterSeconds: number;
}

interface Bucket {
	count: number;
	resetAt: number;
}

/**
 * Rate limiter in-memory theo isolate.
 * Lưu ý (xem ADR/ops): isolate không chia sẻ state giữa PoP, nên đây là lớp phòng thủ
 * ứng dụng; lớp authoritative là Rate Limiting Rule của Cloudflare (Free: 1 rule).
 */
export class MemoryRateLimiter {
	private readonly buckets = new Map<string, Bucket>();
	/** Số key tối đa — chặn rò bộ nhớ khi attacker dùng key khác nhau (SEC-15). */
	private readonly maxBuckets: number;

	constructor(
		private readonly limit: number,
		private readonly windowMs: number,
		maxBuckets = 10_000,
	) {
		this.maxBuckets = maxBuckets;
		limiterRegistry.add(new WeakRef(this));
	}

	/** Tiêu thụ 1 lần; trả về quyết định cho lần gọi hiện tại. */
	consume(key: string, nowMs = Date.now()): RateLimitDecision {
		const bucket = this.buckets.get(key);
		if (!bucket || bucket.resetAt <= nowMs) {
			// Chặn rò bộ nhớ: khi đã đủ key, dọn bucket hết hạn trước; nếu vẫn
			// đầy ⇒ KHÔNG thêm key mới (coi như bị chặn) thay vì phình vô hạn.
			if (this.buckets.size >= this.maxBuckets) {
				this.sweep(nowMs);
				if (this.buckets.size >= this.maxBuckets) {
					return {
						allowed: false,
						remaining: 0,
						retryAfterSeconds: Math.max(1, Math.ceil(this.windowMs / 1000)),
					};
				}
			}
			this.buckets.set(key, { count: 1, resetAt: nowMs + this.windowMs });
			return { allowed: true, remaining: this.limit - 1, retryAfterSeconds: 0 };
		}
		if (bucket.count >= this.limit) {
			return {
				allowed: false,
				remaining: 0,
				retryAfterSeconds: Math.max(1, Math.ceil((bucket.resetAt - nowMs) / 1000)),
			};
		}
		bucket.count += 1;
		return { allowed: true, remaining: this.limit - bucket.count, retryAfterSeconds: 0 };
	}

	reset(key: string): void {
		this.buckets.delete(key);
	}

	/** Dọn bucket hết hạn — gọi định kỳ để tránh rò rỉ memory trong isolate dài hạn. */
	sweep(nowMs = Date.now()): number {
		let removed = 0;
		for (const [key, bucket] of this.buckets) {
			if (bucket.resetAt <= nowMs) {
				this.buckets.delete(key);
				removed += 1;
			}
		}
		return removed;
	}
}

/**
 * Registry các limiter đang hoạt động — cron gọi `sweepAllLimiters()` để dọn
 * bucket hết hạn (SEC-15). Registry tự xoá khi limiter bị GC (WeakRef).
 */
const limiterRegistry = new Set<WeakRef<MemoryRateLimiter>>();

/** Dọn bucket hết hạn của mọi limiter đã đăng ký. Trả về số bucket đã xoá. */
export function sweepAllLimiters(nowMs = Date.now()): number {
	let removed = 0;
	for (const ref of limiterRegistry) {
		const limiter = ref.deref();
		if (!limiter) {
			limiterRegistry.delete(ref);
			continue;
		}
		removed += limiter.sweep(nowMs);
	}
	return removed;
}

export interface RateLimitPolicy {
	/** Số lần cho phép trong window. */
	limit: number;
	/** Độ dài window (ms). */
	windowMs: number;
}

export const DEFAULT_POLICIES = {
	/** Brute-force mật khẩu theo IP. */
	login: { limit: 5, windowMs: 15 * 60 * 1000 },
	/** Brute-force mật khẩu theo tài khoản (chỉ có 1 owner ⇒ chống xoay IP). */
	loginAccount: { limit: 30, windowMs: 15 * 60 * 1000 },
	/** Mã khôi phục: 10 mã, mỗi mã 1 lần ⇒ giới hạn nghiêm hơn login. */
	recoveryLogin: { limit: 5, windowMs: 15 * 60 * 1000 },
	shareUnlock: { limit: 10, windowMs: 15 * 60 * 1000 },
	bootstrap: { limit: 3, windowMs: 60 * 60 * 1000 },
	write: { limit: 120, windowMs: 10 * 60 * 1000 },
} satisfies Record<string, RateLimitPolicy>;
