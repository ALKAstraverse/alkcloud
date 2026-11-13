import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { buildExportArgs, parseBackupArgs } from '../backup-d1.js';

/**
 * WS-L2/M14 — hồi quy `backup-d1.ts`.
 *
 * BUG-02 (phát hiện 13/11/2026, trước Phase 5 production):
 *   `backup-d1.ts` **bỏ qua** cờ `--remote` và luôn export `--local`.
 *   ⇒ `npm run backup:d1 -- --remote` (quy trình docs/21 §2.1) tạo file backup
 *   từ database LOCAL ⇒ file backup KHÔNG phản ánh dữ liệu production.
 *
 * Bất biến:
 *   BK1. `--remote` ⇒ scope remote; không có cờ ⇒ local (mặc định an toàn).
 *   BK2. Lệnh export có **đúng một** scope (`--remote` XOR `--local`).
 *   BK3. `--upload` độc lập với scope.
 */

describe('WS-L2/M14 — backup D1 scope', () => {
	it('BK1 — --remote chọn scope production, mặc định là local', () => {
		assert.deepEqual(parseBackupArgs([]), { remote: false, upload: false });
		assert.deepEqual(parseBackupArgs(['--remote']), { remote: true, upload: false });
		assert.deepEqual(parseBackupArgs(['--upload']), { remote: false, upload: true });
		assert.deepEqual(parseBackupArgs(['--remote', '--upload']), { remote: true, upload: true });
	});

	it('BK2 — lệnh export chỉ có MỘT scope', () => {
		const local = buildExportArgs('/tmp/x.sql', false);
		const remote = buildExportArgs('/tmp/x.sql', true);
		assert.ok(local.includes('--local'));
		assert.ok(!local.includes('--remote'));
		assert.ok(remote.includes('--remote'));
		assert.ok(!remote.includes('--local'));
		// Không được có cả hai cờ (wrangler có thể ưu tiên sai database).
		for (const args of [local, remote]) {
			const scopes = args.filter((arg) => arg === '--local' || arg === '--remote');
			assert.equal(scopes.length, 1);
		}
	});

	it('BK3 — lệnh export trỏ đúng database + file output', () => {
		const args = buildExportArgs('/tmp/backup.sql', true);
		assert.ok(args.includes('alkcloud'));
		assert.ok(args.includes('--output'));
		assert.ok(args.includes('/tmp/backup.sql'));
		assert.ok(args.includes('d1'));
		assert.ok(args.includes('export'));
	});
});
