import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { Database, runMigrations } from '@alkcloud/db';
import { SqliteDriver } from '@alkcloud/db/sqlite';
import { MockObjectStorage } from '@alkcloud/storage';
import { createApp } from '../src/app.js';
import type { Env } from '../src/env.js';
import { resolveConfig } from '../src/env.js';
import { loadMigrationFiles } from '../../../packages/db/test/helpers.js';
import { API, AUTH_KEY, ORIGIN, SETUP_TOKEN, createHarness } from './harness.js';

describe('concurrency', () => {
	it('hai complete đồng thời: một 201, một 409', async () => {
		const harness = await createHarness();
		const session = await harness.request('/uploads', {
			method: 'POST',
			body: { fileName: 'race.txt', contentType: 'text/plain', totalSize: 2, checksumSha256: null },
		});
		const body = (await session.json()) as { uploadSessionId: string; parts: { url: string }[] };
		const key = harness.storage.keyFromPresignedUrl(body.parts[0]!.url);
		harness.storage.putObject(key, {
			size: 2,
			contentType: 'text/plain',
			etag: 'etag-race',
			body: new TextEncoder().encode('ok'),
		});
		const payload = { parts: [{ partNumber: 1, etag: 'etag-race', size: 2 }], checksumSha256: null };
		const [first, second] = await Promise.all([
			harness.request(`/uploads/${body.uploadSessionId}/complete`, { method: 'POST', body: payload }),
			harness.request(`/uploads/${body.uploadSessionId}/complete`, { method: 'POST', body: payload }),
		]);
		const statuses = [first.status, second.status].sort();
		assert.deepEqual(statuses, [201, 409]);
		const files = await harness.request('/files');
		assert.equal(((await files.json()) as { files: unknown[] }).files.length, 1);
	});

	it('hai bootstrap đồng thời: chỉ một owner được tạo', async () => {
		const driver = new SqliteDriver(':memory:');
		await runMigrations(driver, loadMigrationFiles());
		const db = new Database(driver);
		const app = createApp({
			db,
			storage: new MockObjectStorage(),
			config: resolveConfig({
				ALKCLOUD_ALLOWED_ORIGINS: ORIGIN,
				ALKCLOUD_PUBLIC_URL: 'https://cloud.alk.xx.kg',
				ALKCLOUD_API_URL: API,
				AUTH_PEPPER: 'test-pepper-value-0123456789',
				BOOTSTRAP_SETUP_TOKEN: SETUP_TOKEN,
				ENVIRONMENT: 'test',
			} as unknown as Env),
		});
		const makeRequest = (email: string) =>
			app.fetch(
				new Request(`${API}/auth/bootstrap`, {
					method: 'POST',
					headers: { 'content-type': 'application/json', origin: ORIGIN },
					body: JSON.stringify({
						setupToken: SETUP_TOKEN,
						email,
						authKey: AUTH_KEY,
						authVerifierSalt: 'salt-12345678',
						authParams: 'params-12345678',
					}),
				}),
			);
		const [first, second] = await Promise.all([
			makeRequest('first@alkcloud.test'),
			makeRequest('second@alkcloud.test'),
		]);
		const statuses = [first.status, second.status].sort();
		assert.deepEqual(statuses, [201, 409]);
		assert.equal(await db.countOwners(), 1);
	});

	it('đổi mật khẩu thu hồi mọi session khác', async () => {
		const harness = await createHarness();
		const other = await harness.request('/auth/login', {
			method: 'POST',
			body: { email: 'owner@alkcloud.test', authKey: AUTH_KEY },
			cookie: '',
		});
		assert.equal(other.status, 200);
		const otherCookie = (other.headers.get('set-cookie') ?? '').split(';')[0] ?? '';
		assert.equal((await harness.request('/auth/session', { cookie: otherCookie })).status, 200);

		const change = await harness.request('/auth/password', {
			method: 'POST',
			body: {
				currentAuthKey: AUTH_KEY,
				newAuthKey: 'new-auth-key-0000000000000000',
				newAuthVerifierSalt: 'salt-87654321',
				newAuthParams: 'params-87654321',
			},
		});
		assert.equal(change.status, 200);
		assert.equal((await harness.request('/auth/session', { cookie: otherCookie })).status, 401);
	});

	it('nhiều upload session đồng thời không vượt quota', async () => {
		const harness = await createHarness();
		await harness.db.setSetting('quotaBytes', 100, '2026-01-15T10:00:00.000Z');
		const responses = await Promise.all(
			Array.from({ length: 5 }, (_, index) =>
				harness.request('/uploads', {
					method: 'POST',
					body: {
						fileName: `race-${index}.bin`,
						contentType: 'application/octet-stream',
						totalSize: 30,
						checksumSha256: null,
					},
				}),
			),
		);
		const created = responses.filter((response) => response.status === 201).length;
		assert.equal(created, 3);
	});
});
