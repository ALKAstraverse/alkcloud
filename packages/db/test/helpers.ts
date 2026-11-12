import { readdirSync, readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Database, runMigrations } from '@alkcloud/db';
import { SqliteDriver } from '@alkcloud/db/sqlite';

const here = dirname(fileURLToPath(import.meta.url));
const MIGRATIONS_DIR = resolve(here, '../../../apps/api/migrations');

export function loadMigrationFiles(): { name: string; content: string }[] {
	return readdirSync(MIGRATIONS_DIR)
		.filter((name) => name.endsWith('.sql'))
		.sort()
		.map((name) => ({ name, content: readFileSync(join(MIGRATIONS_DIR, name), 'utf8') }));
}

export interface TestDb {
	db: Database;
	driver: SqliteDriver;
	now: string;
}

export async function createTestDb(now = '2026-01-01T00:00:00.000Z'): Promise<TestDb> {
	const driver = new SqliteDriver(':memory:');
	await runMigrations(driver, loadMigrationFiles());
	return { db: new Database(driver), driver, now };
}

export const OWNER_INPUT = {
	id: 'own_test',
	email: 'owner@alkcloud.test',
	authVerifierHash: 'verifier-hash',
	authVerifierSalt: 'salt-12345678',
	authParams: 'params-12345678',
	createdAt: '2026-01-01T00:00:00.000Z',
};
