#!/usr/bin/env node
/**
 * Seed dữ liệu mẫu cho AlkCloud (chỉ dùng local dev / test).
 *
 *   node --import tsx scripts/seed.ts
 *
 * KHÔNG chạy seed lên D1 production: owner phải tự bootstrap qua UI
 * (POST /api/v1/auth/bootstrap) để không lộ recovery code trong log.
 */

import { Database } from '@alkcloud/db';
import { SqliteDriver } from '@alkcloud/db/sqlite';
import { runMigrations } from '@alkcloud/db';
import { readdirSync, readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const MIGRATIONS_DIR = resolve(here, '../apps/api/migrations');

async function main(): Promise<void> {
	const driver = new SqliteDriver(':memory:');
	const files = readdirSync(MIGRATIONS_DIR)
		.filter((name) => name.endsWith('.sql'))
		.sort()
		.map((name) => ({ name, content: readFileSync(join(MIGRATIONS_DIR, name), 'utf8') }));
	await runMigrations(driver, files);
	const db = new Database(driver);

	const now = new Date().toISOString();
	await db.createOwner({
		id: 'own_seed',
		email: 'owner@alkcloud.test',
		authVerifierHash: 'seed-verifier-hash',
		authVerifierSalt: 'seed-salt-1234',
		authParams: 'seed-params-1234',
		createdAt: now,
	});
	const folder = await db.createFolder({
		id: 'fld_seed',
		parentId: null,
		name: 'Tài liệu mẫu',
		depth: 0,
		now,
	});
	await db.createFile({
		id: 'fil_seed',
		folderId: folder.id,
		name: 'readme.txt',
		size: 64,
		contentType: 'text/plain',
		objectKey: 'objects/fil_seed/readme.txt',
		revisionId: 'rev_seed',
		etag: null,
		checksumSha256: null,
		now,
	});

	console.log('Seed hoàn tất (SQLite in-memory):');
	console.log(`  owner: owner@alkcloud.test`);
	console.log(`  folder: ${folder.name}`);
	console.log('Lưu ý: dữ liệu seed KHÔNG bền — chỉ dùng để kiểm tra schema.');
}

void main();
