import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { createHarness } from './harness.js';
import { runScheduledTasks } from '../src/lib/scheduled.js';
import { EVENTS, emit, info } from '../src/lib/observability.js';
import { MockObjectStorage, ResilientStorage, StorageError } from '@alkcloud/storage';
import type { StorageEvent } from '@alkcloud/storage';

/**
 * WS-K — kiểm thử observability.
 *
 * Bất biến:
 *   O1. Mỗi dòng log là 1 JSON object, có `ts` + `level` + `event`.
 *   O2. Mọi giá trị đi qua redaction ⇒ không rò secret.
 *   O3. Không log dữ liệu người dùng (không có tên file/email trong log).
 *   O4. Cron ghi heartbeat vào D1; heartbeat sai ⇒ `stale` báo đúng.
 *   O5. `/system/diagnostics` trả đủ tín hiệu sức khoẻ.
 */

describe('WS-K — log có cấu trúc', () => {
	it('O1 — mỗi dòng log là JSON object có ts/level/event', () => {
		const lines: string[] = [];
		const original = console.log;
		console.log = (value: unknown) => {
			lines.push(String(value));
		};
		try {
			info(EVENTS.cronStarted, { durationMs: 12 });
		} finally {
			console.log = original;
		}
		assert.equal(lines.length, 1);
		const parsed = JSON.parse(lines[0]!) as Record<string, unknown>;
		assert.equal(parsed.level, 'info');
		assert.equal(parsed.event, EVENTS.cronStarted);
		assert.ok(typeof parsed.ts === 'string' && parsed.ts.length > 0);
		assert.equal(parsed.durationMs, 12);
		// 1 dòng = 1 JSON (không có newline trong chuỗi).
		assert.ok(!lines[0]!.includes('\n'));
	});

	it('O2 — giá trị nhạy cảm bị redact trước khi log', () => {
		const lines: string[] = [];
		const original = console.log;
		console.log = (value: unknown) => {
			lines.push(String(value));
		};
		try {
			emit('error', EVENTS.storageError, {
				authorization: 'Bearer super-secret-token-value',
				password: 'hunter2',
				errorName: 'TypeError',
			});
		} finally {
			console.log = original;
		}
		const output = lines[0]!;
		assert.ok(!output.includes('super-secret-token-value'), 'không được lộ token');
		assert.ok(!output.includes('hunter2'), 'không được lộ mật khẩu');
		assert.ok(output.includes('[REDACTED]'));
		assert.ok(output.includes('TypeError'), 'thông tin chẩn đoán vẫn phải còn');
	});

	it('O3 — không tự động ghi tên file/email vào log', () => {
		const lines: string[] = [];
		const original = console.log;
		console.log = (value: unknown) => {
			lines.push(String(value));
		};
		try {
			// Chỉ truyền field đã ẩn danh ⇒ log không chứa PII.
			info(EVENTS.filePurged, { path: '/api/v1/files/abc', method: 'DELETE', status: 200 });
		} finally {
			console.log = original;
		}
		assert.ok(!lines[0]!.includes('@'));
		assert.ok(lines[0]!.includes('/api/v1/files/abc'));
	});
});

describe('WS-K — heartbeat sức khoẻ', () => {
	it('O4 — cron ghi heartbeat, diagnostics báo stale=false', async () => {
		const harness = await createHarness();
		await runScheduledTasks({
			db: harness.db,
			storage: harness.storage,
			config: harness.config,
			env: {} as never,
			scheduledTime: new Date('2026-01-15T10:00:00.000Z').getTime(),
		});

		const heartbeat = await harness.db.getHealthHeartbeat();
		assert.ok(heartbeat, 'cron phải ghi heartbeat');
		assert.equal(heartbeat.status, 'ok');
		assert.equal(heartbeat.updatedAt, '2026-01-15T10:00:00.000Z');
		assert.equal(typeof heartbeat.data.durationMs, 'number');

		const response = await harness.request('/system/diagnostics');
		assert.equal(response.status, 200);
		const body = (await response.json()) as {
			cron: { lastRunAt: string | null; stale: boolean; status: string };
		};
		assert.equal(body.cron.lastRunAt, '2026-01-15T10:00:00.000Z');
		assert.equal(body.cron.stale, false, 'heartbeat vừa ghi ⇒ không stale');
		assert.equal(body.cron.status, 'ok');
	});

	it('O4b — chưa có cron nào chạy ⇒ stale=true', async () => {
		const harness = await createHarness();
		const response = await harness.request('/system/diagnostics');
		assert.equal(response.status, 200);
		const body = (await response.json()) as {
			cron: { lastRunAt: string | null; stale: boolean; status: string };
		};
		assert.equal(body.cron.lastRunAt, null);
		assert.equal(body.cron.stale, true);
		assert.equal(body.cron.status, 'never_run');
	});

	it('O4c — cron lỗi ⇒ heartbeat status=error', async () => {
		const harness = await createHarness();
		// DB "hỏng" có chọn lọc: mọi truy vấn thành công, trừ bước dọn session
		// ⇒ cron hỏng giữa chừng nhưng vẫn ghi được heartbeat lỗi.
		const brokenDb = new Proxy(harness.db, {
			get(target, property, receiver) {
				if (property === 'deleteExpiredSessions') {
					return async () => {
						throw new Error('db unavailable');
					};
				}
				const value = Reflect.get(target, property, receiver);
				return typeof value === 'function' ? value.bind(target) : value;
			},
		});
		await assert.rejects(() =>
			runScheduledTasks({
				db: brokenDb,
				storage: harness.storage,
				config: harness.config,
				env: {} as never,
				scheduledTime: new Date('2026-01-15T10:00:00.000Z').getTime(),
			}),
		);
		const heartbeat = await harness.db.getHealthHeartbeat();
		assert.ok(heartbeat, 'cron lỗi vẫn phải ghi heartbeat');
		assert.equal(heartbeat.status, 'error');
	});
});

describe('WS-K — cầu nối lớp lưu trữ → log', () => {
	it('O6 — retry / circuit_open / failure đều phát sự kiện', async () => {
		const events: StorageEvent[] = [];
		const inner = new MockObjectStorage();
		const storage = new ResilientStorage(inner, {
			onEvent: (event) => events.push(event),
			retry: { maxAttempts: 2, baseDelayMs: 1, maxDelayMs: 1, totalDelayBudgetMs: 10 },
			sleep: async () => {},
		});

		// Lỗi 503 (retryable) ⇒ phải có event 'retry' rồi 'failure'.
		inner.failWith(new StorageError('unavailable', 503));
		await assert.rejects(() => storage.headObject('objects/x/y'));
		assert.ok(events.some((e) => e.type === 'retry'), 'phải có sự kiện retry');
		assert.ok(events.some((e) => e.type === 'failure'), 'phải có sự kiện failure');
		assert.ok(
			events.every((e) => typeof e.operation === 'string' && e.operation.length > 0),
			'sự kiện phải có tên thao tác',
		);
		// KHÔNG được lộ object key (có thể chứa định danh người dùng).
		assert.ok(!JSON.stringify(events).includes('objects/x/y'));

		// Circuit mở ⇒ event 'circuit_open'.
		events.length = 0;
		inner.failWith(new StorageError('unavailable', 503));
		for (let i = 0; i < 6; i += 1) {
			await assert.rejects(() => storage.headObject('objects/x/y'));
		}
		assert.ok(events.some((e) => e.type === 'circuit_open'), 'phải có sự kiện circuit_open');
		assert.equal(storage.getCircuitState(), 'open');
	});

	it('O6b — callback hỏng không làm hỏng thao tác lưu trữ', async () => {
		const inner = new MockObjectStorage();
		const storage = new ResilientStorage(inner, {
			onEvent: () => {
				throw new Error('observer broken');
			},
		});
		inner.failWith(new StorageError('unavailable', 503));
		await assert.rejects(() => storage.headObject('objects/x/y'));
		inner.clearFailure();
		// Không ném lỗi ⇒ thao tác vẫn chạy được sau khi callback hỏng.
		await storage.headObject('objects/x/y');
	});
});

describe('WS-K — /system/diagnostics', () => {
	it('O5 — trả đủ tín hiệu sức khoẻ', async () => {
		const harness = await createHarness();
		const response = await harness.request('/system/diagnostics');
		assert.equal(response.status, 200);
		const body = (await response.json()) as {
			generatedAt: string;
			cron: { lastRunAt: string | null; stale: boolean };
			degradation: { mode: string; consecutiveBelow: number };
			storage: { configured: boolean; circuit: string | null };
			quota: { quotaBytes: number; usedBytes: number; reservedBytes: number; freeBytes: number };
			analytics: { configured: boolean };
		};
		assert.ok(body.generatedAt);
		assert.equal(body.cron.stale, true);
		assert.equal(body.degradation.mode, 'NORMAL');
		assert.equal(body.storage.configured, false, 'chưa cấu hình B2 ⇒ configured=false');
		assert.equal(body.storage.circuit, null, 'mock storage không có circuit');
		assert.ok(body.quota.quotaBytes > 0);
		assert.equal(body.quota.usedBytes, 0);
		assert.equal(body.quota.freeBytes, body.quota.quotaBytes);
		assert.equal(body.analytics.configured, false);
	});

	it('O5b — endpoint yêu cầu phiên owner (không public)', async () => {
		const harness = await createHarness();
		const response = await harness.request('/system/diagnostics', { cookie: '' });
		assert.equal(response.status, 401, 'phải có phiên owner');
	});
});
