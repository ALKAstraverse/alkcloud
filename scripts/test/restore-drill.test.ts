import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { DrillArgsError, parseDrillArgs } from '../lib/drill-args.js';

/**
 * WS-L2/M14 — hồi quy `restore-drill.ts`.
 *
 * BUG-08 (phát hiện 13/11/2026, Phase 5 production):
 *   `restore-drill.ts` không nhận file backup có sẵn — luôn export D1 local.
 *   ⇒ không chứng minh được "restore được từ file backup production".
 *
 * Bất biến:
 *   DR1. `--file <path>` ⇒ dùng dump có sẵn.
 *   DR2. `--remote` ⇒ TỪ CHỐI (drill không bao giờ đụng production).
 *   DR3. `--file` + `--json` đi cùng nhau hợp lệ; thiếu giá trị ⇒ lỗi.
 */

describe('WS-L2/M14 — restore drill args', () => {
	it('DR1 — --file chọn dump có sẵn, mặc định export local', () => {
		assert.deepEqual(parseDrillArgs([]), {});
		assert.deepEqual(parseDrillArgs(['--file', '/tmp/backup.sql']), {
			file: '/tmp/backup.sql',
		});
	});

	it('DR2 — --remote bị từ chối', () => {
		assert.throws(() => parseDrillArgs(['--remote']), DrillArgsError);
		assert.throws(() => parseDrillArgs(['--file', '/tmp/x.sql', '--remote']), DrillArgsError);
	});

	it('DR3 — --file và --json đi cùng nhau; thiếu giá trị thì lỗi', () => {
		assert.deepEqual(parseDrillArgs(['--file', '/tmp/x.sql', '--json', '/tmp/r.json']), {
			file: '/tmp/x.sql',
			json: '/tmp/r.json',
		});
		assert.throws(() => parseDrillArgs(['--file']), DrillArgsError);
		assert.throws(() => parseDrillArgs(['--file', '--remote']), DrillArgsError);
		assert.throws(() => parseDrillArgs(['--json']), DrillArgsError);
	});
});
