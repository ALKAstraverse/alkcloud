/**
 * Khai báo tối thiểu cho Worker runtime.
 * Cố ý KHÔNG dùng `@cloudflare/workers-types` toàn cục để tránh xung đột với lib DOM
 * trong frontend (Vite/React). Chỉ khai báo các type thực sự dùng.
 */

interface ExecutionContext {
	waitUntil(promise: Promise<unknown>): void;
	passThroughOnException(): void;
	props: unknown;
}

interface ScheduledController {
	readonly scheduledTime: number;
	readonly cron: string;
	noRetry(): void;
}

interface ExecutionContextLike {
	waitUntil(promise: Promise<unknown>): void;
}
