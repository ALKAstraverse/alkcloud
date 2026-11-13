import type { Env } from './env.js';
import { resolveConfig } from './env.js';
import { D1Driver, Database } from '@alkcloud/db';
import { B2Storage, ResilientStorage } from '@alkcloud/storage';
import { createApp } from './app.js';
import { warmUpSchemas } from '@alkcloud/core';
import { NotConfiguredStorage } from './lib/not-configured-storage.js';
import { runScheduledTasks } from './lib/scheduled.js';
import { EVENTS, error as logError, warn as logWarn } from './lib/observability.js';
import type { AppEnv } from './middleware/auth.js';
import type { Hono } from 'hono';

function createStorage(env: Env) {
	const config = resolveConfig(env);
	const { endpoint, region, bucket, accessKeyId, secretAccessKey, relayUrl, relayToken } = config.b2;
	if (!endpoint || !region || !bucket || !accessKeyId || !secretAccessKey) {
		return new NotConfiguredStorage();
	}
	// WS-B: bọc retry + circuit breaker ⇒ lỗi tạm thời của B2 không làm hỏng
	// phiên upload/download, và khi B2 đang chết thì fail-fast thay vì treo.
	return new ResilientStorage(
		new B2Storage({
			endpoint,
			region,
			bucket,
			accessKeyId,
			secretAccessKey,
			// Worker gắn route zone alk.xx.kg fetch B2 trả 525 ⇒ request server-side
			// đi qua relay workers.dev; presigned URL vẫn trỏ thẳng B2.
			...(relayUrl && relayToken ? { proxy: { url: relayUrl, token: relayToken } } : {}),
		}),
		{
			// WS-K: lớp lưu trữ không tự log (giữ package độc lập) — nó phát sự
			// kiện, app nối vào hệ thống log có cấu trúc + redact.
			onEvent: (event) => {
				if (event.type === 'retry') {
					logWarn(EVENTS.storageRetry, {
						operation: event.operation,
						attempt: event.attempt,
						delayMs: event.delayMs,
						errorName: event.errorName,
						status: event.status,
					});
					return;
				}
				if (event.type === 'circuit_open') {
					logError(EVENTS.storageCircuitOpen, {
						operation: event.operation,
						attempt: event.attempt,
					});
					return;
				}
				logError(EVENTS.storageError, {
					operation: event.operation,
					attempt: event.attempt,
					errorName: event.errorName,
					status: event.status,
				});
			},
		},
	);
}

// Zod 4 compile lazy — ép compile lúc startup để không trừ CPU của request
// đầu tiên trong mừi isolate (Workers Free chỉ 10ms CPU/request).
warmUpSchemas();

/**
 * App + rate limiter PHẢI được tạo MỘT LẦN cho mỗi isolate.
 *
 * LÝ DO (bug nghiêm trọng đã phát hiện & sửa ở Phase 4 — SEC-01):
 * `createApp()` khởi tạo route, và mỗi route tạo `MemoryRateLimiter` của riêng nó
 * (login, bootstrap, share unlock). Nếu app được dựng lại **mỗi request**, thì
 * mọi limiter đều rỗng ⇒ rate limit KHÔNG BAO GIỜ kích hoạt ⇒ attacker thử
 * mật khẩu/guess setup token/mở khoá share không bị chặn.
 *
 * Cloudflare Workers giữ module scope sống suốt vòng đời isolate ⇒ cache ở
 * module scope ⇒ limiter dùng chung state cho mọi request của isolate đó.
 * (Lưu ý: state KHÔNG chia sẻ giữa các PoP — lớp authoritative vẫn là
 * Cloudflare Rate Limiting Rule, xem `docs/17`.)
 *
 * Cache được khoá theo identity của binding D1: trong một deployment, `env.DB`
 * là cùng một object reference cho mọi request của isolate. Secret đổi ⇒
 * deployment mới ⇒ isolate mới ⇒ cache tự nhiên được làm mới.
 */
interface CachedApp {
	key: unknown;
	app: Hono<AppEnv>;
}

let cachedApp: CachedApp | null = null;

function getApp(env: Env): Hono<AppEnv> {
	const key = env.DB ?? env;
	if (cachedApp && cachedApp.key === key) return cachedApp.app;
	const config = resolveConfig(env);
	const driver = new D1Driver(env.DB);
	const db = new Database(driver);
	const storage = createStorage(env);
	const app = createApp({ db, storage, config });
	cachedApp = { key, app };
	return app;
}

export interface WorkerApp {
	fetch(request: Request, env: Env, ctx: ExecutionContext): Promise<Response>;
	scheduled(event: ScheduledController, env: Env, ctx: ExecutionContext): Promise<void>;
}

/** Tạo Worker object — dùng cho test để kiểm tra hành vi GIỐNG production. */
export function createWorkerApp(): WorkerApp {
	return {
		async fetch(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
			const app = getApp(env);
			return app.fetch(request, env, ctx);
		},

		async scheduled(event: ScheduledController, env: Env, ctx: ExecutionContext): Promise<void> {
			const config = resolveConfig(env);
			const driver = new D1Driver(env.DB);
			const db = new Database(driver);
			const storage = createStorage(env);
			ctx.waitUntil(runScheduledTasks({ db, storage, config, env, scheduledTime: event.scheduledTime }));
		},
	};
}

export default createWorkerApp();
