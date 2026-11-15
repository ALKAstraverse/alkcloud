import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { createTestDb } from './helpers.js';

/**
 * Migration 0007 — đường đọc metadata phải dùng index (D1 tính tiền theo row đọc).
 * AlkCloud single-owner nên không có `user_id`; khoá cây là `folder_id`/`parent_id`.
 */

async function plan(sql: string, params: unknown[] = []): Promise<string> {
	const { driver } = await createTestDb();
	const result = await driver.query<{ detail: string }>(`EXPLAIN QUERY PLAN ${sql}`, params);
	return result.rows.map((row) => row.detail).join(' | ');
}

describe('Migration 0007 — index cho list metadata', () => {
	it('file trong thư mục: dùng idx_files_active_folder_name (không SCAN + sort)', async () => {
		const details = await plan(
			'SELECT * FROM files WHERE folder_id = ? AND deleted_at IS NULL ORDER BY name_lower ASC, id ASC LIMIT 50 OFFSET 0',
			['fld_x'],
		);
		assert.match(details, /idx_files_active_folder_name/, details);
		assert.ok(!/SCAN files\b/.test(details), details);
	});

	it('file thư mục gốc: dùng idx_files_active_folder_name (folder_id NULL)', async () => {
		const details = await plan(
			'SELECT * FROM files WHERE folder_id IS NULL AND deleted_at IS NULL ORDER BY name_lower ASC, id ASC LIMIT 50 OFFSET 0',
		);
		assert.match(details, /idx_files_active_folder_name/, details);
		assert.ok(!/USE TEMP B-TREE FOR ORDER BY/.test(details), details);
	});

	it('folder con: dùng idx_folders_active_parent_name', async () => {
		const details = await plan(
			'SELECT * FROM folders WHERE parent_id = ? AND deleted_at IS NULL ORDER BY name_lower ASC LIMIT 50 OFFSET 0',
			['fld_x'],
		);
		assert.match(details, /idx_folders_active_parent_name/, details);
	});

	it('share theo file: dùng idx_shares_file_created', async () => {
		const details = await plan(
			'SELECT * FROM shares WHERE file_id = ? ORDER BY created_at DESC LIMIT 50 OFFSET 0',
			['fil_x'],
		);
		assert.match(details, /idx_shares_file_created/, details);
	});

	it('upload session OPEN: dùng idx_upload_sessions_open_created', async () => {
		const details = await plan(
			"SELECT * FROM upload_sessions WHERE status = 'OPEN' ORDER BY created_at ASC LIMIT 50",
		);
		assert.match(details, /idx_upload_sessions_open_created/, details);
	});
});
