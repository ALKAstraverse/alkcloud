import type { Env } from './env.js';
import { resolveConfig } from './env.js';
import { D1Driver, Database } from '@alkcloud/db';
import { B2Storage } from '@alkcloud/storage';
import { createApp } from './app.js';
import { warmUpSchemas } from '@alkcloud/core';
import { NotConfiguredStorage } from './lib/not-configured-storage.js';
import { runScheduledTasks } from './lib/scheduled.js';

function createStorage(env: Env) {
	const config = resolveConfig(env);
	const { endpoint, region, bucket, accessKeyId, secretAccessKey } = config.b2;
	if (!endpoint || !region || !bucket || !accessKeyId || !secretAccessKey) {
		return new NotConfiguredStorage();
	}
	return new B2Storage({ endpoint, region, bucket, accessKeyId, secretAccessKey });
}

// Zod 4 compile lazy — ép compile lúc startup để không trừ CPU của request
// đầu tiên trong mỗi isolate (Workers Free chỉ 10ms CPU/request).
warmUpSchemas();

export default {
	async fetch(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
		const config = resolveConfig(env);
		const driver = new D1Driver(env.DB);
		const db = new Database(driver);
		const storage = createStorage(env);
		const app = createApp({ db, storage, config });
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
