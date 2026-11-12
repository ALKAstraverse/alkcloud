import { AppError, capabilitiesFor, DEFAULT_QUOTA_BYTES, utcDateKey } from '@alkcloud/core';
import { Hono } from 'hono';
import type { AppContext } from '../context.js';
import { readQuotaState } from '../context.js';
import { json } from '../lib/http.js';
import { requireOwner, type AppEnv } from '../middleware/auth.js';

export function createSystemRoutes(context: AppContext): Hono<AppEnv> {
	const app = new Hono<AppEnv>();
	app.use('*', requireOwner(context));

	app.get('/quota', async (c) => {
		const state = await readQuotaState(context.db, context.config.quotaStateTtlSeconds);
		const day = utcDateKey(context.now().getTime());
		const usage = await context.db.getUsageDaily(day);
		const mode = state?.mode ?? 'NORMAL';
		return json({
			mode,
			capabilities: capabilitiesFor(mode),
			account: {
				requestsUsed: state?.accountRequestsUsed ?? null,
				requestLimit: state?.accountRequestLimit ?? context.config.accountDailyRequestLimit,
			},
			budget: {
				apiCallsUsed: state?.alkApiCallsUsed ?? usage?.api_calls ?? 0,
				apiCallBudget: state?.alkApiBudget ?? context.config.dailyApiBudget,
				note: 'Budget là provisional design budget, KHÔNG phải hard cap.',
			},
			evaluatedAt: state?.evaluatedAt ?? null,
			reason: state?.reason ?? 'chưa có dữ liệu đánh giá',
		});
	});

	app.get('/usage', async (c) => {
		const day = c.req.query('day') ?? utcDateKey(context.now().getTime());
		const usage = await context.db.getUsageDaily(day);
		const owner = await context.db.getOwner();
		const quotaBytes = Number((await context.db.getSetting<number>('quotaBytes')) ?? DEFAULT_QUOTA_BYTES);
		const reservedBytes = owner ? await context.db.reservedQuotaBytes(owner.id) : 0;
		const usedBytes = await context.db.sumActiveFileBytes();
		return json({
			day,
			usage,
			quotaBytes,
			usedBytes,
			reservedBytes,
			freeBytes: Math.max(0, quotaBytes - usedBytes - reservedBytes),
		});
	});

	app.get('/audit', async (c) => {
		const limitRaw = Number(c.req.query('limit') ?? '100');
		const limit = Number.isFinite(limitRaw) ? Math.min(500, Math.max(1, limitRaw)) : 100;
		const events = await context.db.listAudit(limit);
		return json({ events });
	});

	app.get('/health/deep', async (c) => {
		const owner = await context.db.getOwner();
		if (!owner) throw AppError.notFound('Owner chưa được khởi tạo');
		return json({
			status: 'ok',
			bootstrapped: true,
			time: context.now().toISOString(),
			storageConfigured: Boolean(
				context.config.b2.endpoint && context.config.b2.bucket && context.config.b2.accessKeyId,
			),
			analyticsConfigured: Boolean(context.config.cloudflareAnalyticsToken),
		});
	});

	return app;
}
