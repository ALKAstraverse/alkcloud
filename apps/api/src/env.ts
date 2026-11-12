import type { Database } from '@alkcloud/db';
import type { ObjectStorage } from '@alkcloud/storage';

export interface Env {
	DB: D1DatabaseLike;
	BUCKET?: R2BucketLike;
	ALKCLOUD_ALLOWED_ORIGINS?: string;
	ALKCLOUD_PUBLIC_URL?: string;
	ALKCLOUD_API_URL?: string;
	AUTH_PEPPER?: string;
	BOOTSTRAP_SETUP_TOKEN?: string;
	TURNSTILE_SITE_KEY?: string;
	TURNSTILE_SECRET_KEY?: string;
	ALERT_WEBHOOK_URL?: string;
	B2_ENDPOINT?: string;
	B2_REGION?: string;
	B2_BUCKET?: string;
	B2_ACCESS_KEY_ID?: string;
	B2_SECRET_ACCESS_KEY?: string;
	B2_MAINTENANCE_ACCESS_KEY_ID?: string;
	B2_MAINTENANCE_SECRET_ACCESS_KEY?: string;
	ALKCLOUD_DAILY_API_BUDGET?: string;
	ALKCLOUD_ACCOUNT_DAILY_REQUEST_LIMIT?: string;
	ALKCLOUD_QUOTA_STATE_TTL_SECONDS?: string;
	CLOUDFLARE_ANALYTICS_TOKEN?: string;
	CLOUDFLARE_ACCOUNT_ID?: string;
	ENVIRONMENT?: string;
}

export interface D1ResultMeta {
	changes?: number;
	last_row_id?: number;
	rows_read?: number;
	rows_written?: number;
}

export interface D1PreparedStatement {
	bind(...values: unknown[]): D1PreparedStatement;
	all<T = Record<string, unknown>>(): Promise<{ results: T[]; meta?: D1ResultMeta }>;
	run(): Promise<{ meta?: D1ResultMeta }>;
}

export interface D1DatabaseLike {
	prepare(sql: string): D1PreparedStatement;
	batch(statements: unknown[]): Promise<unknown[]>;
	exec(sql: string): Promise<unknown>;
}

export interface R2BucketLike {
	head(key: string): Promise<unknown>;
}

export interface ResolvedConfig {
	environment: string;
	allowedOrigins: string[];
	publicUrl: string;
	apiUrl: string;
	authPepper: string | null;
	bootstrapSetupToken: string | null;
	turnstileSiteKey: string | null;
	turnstileSecretKey: string | null;
	alertWebhookUrl: string | null;
	dailyApiBudget: number;
	accountDailyRequestLimit: number;
	quotaStateTtlSeconds: number;
	cloudflareAnalyticsToken: string | null;
	cloudflareAccountId: string | null;
	b2: {
		endpoint: string | null;
		region: string | null;
		bucket: string | null;
		accessKeyId: string | null;
		secretAccessKey: string | null;
		maintenanceAccessKeyId: string | null;
		maintenanceSecretAccessKey: string | null;
	};
}

/** Biến chưa cấu hình => null (NOT_CONFIGURED), tuyệt đối không dùng giá trị giả. */
export function resolveConfig(env: Env): ResolvedConfig {
	const dailyApiBudget = Number(env.ALKCLOUD_DAILY_API_BUDGET ?? '20000');
	const accountLimit = Number(env.ALKCLOUD_ACCOUNT_DAILY_REQUEST_LIMIT ?? '100000');
	return {
		environment: env.ENVIRONMENT ?? 'production',
		allowedOrigins: (env.ALKCLOUD_ALLOWED_ORIGINS ?? 'https://cloud.alk.xx.kg')
			.split(',')
			.map((value) => value.trim())
			.filter(Boolean),
		publicUrl: env.ALKCLOUD_PUBLIC_URL ?? 'https://cloud.alk.xx.kg',
		apiUrl: env.ALKCLOUD_API_URL ?? 'https://api.alk.xx.kg/api/v1',
		authPepper: env.AUTH_PEPPER && env.AUTH_PEPPER.length >= 16 ? env.AUTH_PEPPER : null,
		bootstrapSetupToken: env.BOOTSTRAP_SETUP_TOKEN ?? null,
		turnstileSiteKey: env.TURNSTILE_SITE_KEY ?? null,
		turnstileSecretKey: env.TURNSTILE_SECRET_KEY ?? null,
		alertWebhookUrl: env.ALERT_WEBHOOK_URL ?? null,
		dailyApiBudget: Number.isFinite(dailyApiBudget) && dailyApiBudget > 0 ? dailyApiBudget : 20_000,
		accountDailyRequestLimit:
			Number.isFinite(accountLimit) && accountLimit > 0 ? accountLimit : 100_000,
		quotaStateTtlSeconds: Number(env.ALKCLOUD_QUOTA_STATE_TTL_SECONDS ?? '60'),
		cloudflareAnalyticsToken: env.CLOUDFLARE_ANALYTICS_TOKEN ?? null,
		cloudflareAccountId: env.CLOUDFLARE_ACCOUNT_ID ?? null,
		b2: {
			endpoint: env.B2_ENDPOINT ?? null,
			region: env.B2_REGION ?? null,
			bucket: env.B2_BUCKET ?? null,
			accessKeyId: env.B2_ACCESS_KEY_ID ?? null,
			secretAccessKey: env.B2_SECRET_ACCESS_KEY ?? null,
			maintenanceAccessKeyId: env.B2_MAINTENANCE_ACCESS_KEY_ID ?? null,
			maintenanceSecretAccessKey: env.B2_MAINTENANCE_SECRET_ACCESS_KEY ?? null,
		},
	};
}

export interface AppDependencies {
	env: Env;
	db: Database;
	storage: ObjectStorage;
	now?: () => Date;
}
