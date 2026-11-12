import { Hono } from 'hono';
import type { Database } from '@alkcloud/db';
import type { ObjectStorage } from '@alkcloud/storage';
import type { ResolvedConfig } from './env.js';
import { createAuthRoutes } from './routes/auth.js';
import { createFilesRoutes } from './routes/files.js';
import { createFoldersRoutes } from './routes/folders.js';
import { createUploadRoutes } from './routes/uploads.js';
import { createShareAdminRoutes } from './routes/shares.js';
import { createPublicShareRoutes } from './routes/public-share.js';
import { createSystemRoutes } from './routes/system.js';
import { errorResponse, json } from './lib/http.js';
import { loadQuotaState, type AppEnv } from './middleware/auth.js';

export interface AppDeps {
	db: Database;
	storage: ObjectStorage;
	config: ResolvedConfig;
	now?: () => Date;
}

export function createApp(deps: AppDeps): Hono<AppEnv> {
	const app = new Hono<AppEnv>();
	const now = deps.now ?? (() => new Date());
	const context = { db: deps.db, storage: deps.storage, config: deps.config, now };

	app.onError((error) => errorResponse(error));
	app.notFound((c) => json({ error: { code: 'not_found', message: 'Endpoint không tồn tại' } }, 404));

	app.use('*', async (c, next) => {
		const origin = c.req.header('origin');
		if (origin && deps.config.allowedOrigins.includes(origin)) {
			c.res.headers.set('access-control-allow-origin', origin);
			c.res.headers.set('access-control-allow-credentials', 'true');
			c.res.headers.set('vary', 'Origin');
		}
		c.res.headers.set('x-content-type-options', 'nosniff');
		c.res.headers.set('referrer-policy', 'no-referrer');
		c.res.headers.set('x-frame-options', 'DENY');
		c.res.headers.set('strict-transport-security', 'max-age=31536000; includeSubDomains');
		await next();
	});

	app.options('*', (c) =>
		c.body(null, 204, {
			'access-control-allow-methods': 'GET, POST, PATCH, DELETE, OPTIONS',
			'access-control-allow-headers': 'content-type, x-alkcloud-csrf, idempotency-key, x-share-token, x-share-grant',
			'access-control-max-age': '600',
		}),
	);

	app.get('/api/v1/health', (c) =>
		json({
			status: 'ok',
			service: 'alkcloud-api',
			time: now().toISOString(),
			environment: deps.config.environment,
		}),
	);

	// Quota state phải được nạp TRƯỚC các route để cả route public cũng thấy mode.
	app.use('/api/v1/*', loadQuotaState(context));

	app.route('/api/v1/auth', createAuthRoutes(context));
	app.route('/api/v1/files', createFilesRoutes(context));
	app.route('/api/v1/folders', createFoldersRoutes(context));
	app.route('/api/v1/uploads', createUploadRoutes(context));
	app.route('/api/v1/shares', createShareAdminRoutes(context));
	app.route('/api/v1/public', createPublicShareRoutes(context));
	app.route('/api/v1/system', createSystemRoutes(context));

	return app;
}
