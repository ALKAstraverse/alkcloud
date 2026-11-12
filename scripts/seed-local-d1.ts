#!/usr/bin/env node
/**
 * AlkCloud — seed D1 LOCAL (wrangler --local) với dữ liệu mẫu có thật.
 *
 *   node --import tsx scripts/seed-local-d1.ts
 *   node --import tsx scripts/seed-local-d1.ts --reset   # xoá sạch rồi seed
 *
 * LOCAL_WRITE: chỉ ghi vào state local của wrangler (`.wrangler/state`).
 * TỪ CHỐI nếu có `--remote` — không bao giờ seed production.
 *
 * Mục đích: làm cho restore-drill / audit-storage / chaos test có dữ liệu thực tế
 * để đối chiếu (không chỉ bảng rỗng).
 */

import { execFileSync } from 'node:child_process';
import { resolve } from 'node:path';

const argv = process.argv.slice(2);
if (argv.includes('--remote')) {
	console.error('Từ chối: seed KHÔNG chạy trên remote (production).');
	process.exit(2);
}
const reset = argv.includes('--reset');

function sql(command: string): void {
	execFileSync(
		'npx',
		[
			'wrangler',
			'-c',
			'apps/api/wrangler.toml',
			'd1',
			'execute',
			'alkcloud',
			'--local',
			'--command',
			command,
		],
		{ stdio: 'pipe' },
	);
}

function query<T = Record<string, unknown>>(command: string): T[] {
	const out = execFileSync(
		'npx',
		[
			'wrangler',
			'-c',
			'apps/api/wrangler.toml',
			'd1',
			'execute',
			'alkcloud',
			'--local',
			'--json',
			'--command',
			command,
		],
		{ encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] },
	);
	const parsed = JSON.parse(out) as Array<{ results?: T[] }>;
	return parsed.flatMap((item) => item.results ?? []);
}

const now = new Date();
const iso = (offsetDays = 0): string =>
	new Date(now.getTime() + offsetDays * 86_400_000).toISOString();
const isoDate = (offsetDays = 0): string => iso(offsetDays).replace('T', ' ').slice(0, 19);

function main(): void {
	console.log('== AlkCloud — seed D1 LOCAL (LOCAL_WRITE) ==');

	if (reset) {
		console.log('  xoá sạch dữ liệu cũ...');
		for (const table of [
			'audit_chain',
			'audit_logs',
			'shares',
			'upload_sessions',
			'files',
			'folders',
			'sessions',
			'recovery_codes',
			'idempotency_keys',
			'quota_reservations',
			'usage_daily',
			'settings',
			'system_state',
			'owner',
		]) {
			sql(`DELETE FROM ${table};`);
		}
	}

	const ownerCount = Number(query<{ n: number }>('SELECT COUNT(*) AS n FROM owner')[0]?.n ?? 0);
	if (ownerCount > 0 && !reset) {
		console.log('  D1 local đã có owner — bỏ qua seed (dùng --reset để seed lại).');
		return;
	}

	sql(`DELETE FROM owner;`);

	// Owner (hash giả — chỉ để test cấu trúc, KHÔNG đăng nhập được).
	sql(
		`INSERT INTO owner (id,email,auth_verifier_hash,auth_verifier_salt,auth_params,pepper_version,created_at,updated_at)
		 VALUES ('own_seed','owner@alkcloud.test','seed-verifier-hash-not-a-real-hash','seed-salt-1234','seed-params-1234',1,'${isoDate(-30)}','${isoDate(-30)}');`,
	);

	// Folders: root + nested + một folder trong trash.
	sql(
		`INSERT INTO folders (id,parent_id,name,name_lower,depth,created_at,updated_at,deleted_at,deleted_batch_id,version)
		 VALUES
		   ('fld_docs',NULL,'Tài liệu','tài liệu',0,'${isoDate(-20)}','${isoDate(-20)}',NULL,NULL,1),
		   ('fld_photos',NULL,'Ảnh','ảnh',0,'${isoDate(-18)}','${isoDate(-18)}',NULL,NULL,1),
		   ('fld_2025','fld_docs','2025','2025',1,'${isoDate(-19)}','${isoDate(-19)}',NULL,NULL,1),
		   ('fld_old',NULL,'Cũ','cũ',0,'${isoDate(-60)}','${isoDate(-40)}','${isoDate(-40)}','bat_seed_1',1);`,
	);

	// Files: active, trong folder, trong trash, và file có checksum.
	sql(
		`INSERT INTO files (id,folder_id,name,name_lower,size,content_type,object_key,revision_id,etag,checksum_sha256,created_at,updated_at,deleted_at,deleted_batch_id,purge_after,version)
		 VALUES
		   ('fil_readme',NULL,'readme.txt','readme.txt',64,'text/plain','objects/fil_readme/rev_readme','rev_readme','"etag-readme"','${'a'.repeat(64)}','${isoDate(-20)}','${isoDate(-20)}',NULL,NULL,NULL,1),
		   ('fil_doc','fld_2025','kế hoạch.pdf','kế hoạch.pdf',1048576,'application/pdf','objects/fil_doc/rev_doc','rev_doc','"etag-doc"','${'b'.repeat(64)}','${isoDate(-15)}','${isoDate(-15)}',NULL,NULL,NULL,1),
		   ('fil_img','fld_photos','ảnh.png','ảnh.png',204800,'image/png','objects/fil_img/rev_img','rev_img','"etag-img"','${'c'.repeat(64)}','${isoDate(-12)}','${isoDate(-12)}',NULL,NULL,NULL,1),
		   ('fil_trash','fld_old','xoá.txt','xoá.txt',10,'text/plain','objects/fil_trash/rev_trash','rev_trash','"etag-trash"',NULL,'${isoDate(-50)}','${isoDate(-45)}','${isoDate(-45)}','bat_seed_1','${isoDate(-15)}',1);`,
	);

	// Shares: một share còn hiệu lực có mật khẩu, một share đã revoke.
	sql(
		`INSERT INTO shares (id,file_id,token_hash,password_hash,password_salt,password_params,expires_at,max_downloads,download_count,revoked_at,created_at,updated_at)
		 VALUES
		   ('shr_seed_1','fil_doc','seed-token-hash-1','seed-password-hash','seed-salt-1234','sha256','${isoDate(7)}',5,1,NULL,'${isoDate(-5)}','${isoDate(-5)}'),
		   ('shr_seed_2','fil_img','seed-token-hash-2',NULL,NULL,NULL,'${isoDate(-2)}',NULL,3,'${isoDate(-1)}','${isoDate(-10)}','${isoDate(-1)}');`,
	);

	// Sessions: một active, một revoked, một hết hạn.
	sql(
		`INSERT INTO sessions (id,owner_id,token_hash,csrf_secret,created_at,expires_at,last_seen_at,revoked_at,user_agent)
		 VALUES
		   ('ses_seed_active','own_seed','seed-session-hash-active','seed-csrf-active','${isoDate(-1)}','${isoDate(29)}','${isoDate(-1)}',NULL,'seed-agent'),
		   ('ses_seed_revoked','own_seed','seed-session-hash-revoked','seed-csrf-revoked','${isoDate(-20)}','${isoDate(10)}','${isoDate(-19)}','${isoDate(-18)}','seed-agent'),
		   ('ses_seed_expired','own_seed','seed-session-hash-expired','seed-csrf-expired','${isoDate(-60)}','${isoDate(-30)}','${isoDate(-40)}',NULL,'seed-agent');`,
	);

	// Upload sessions: một OPEN còn hạn, một OPEN đã hết hạn (để test reconcile).
	sql(
		`INSERT INTO upload_sessions (id,file_name,file_name_lower,folder_id,content_type,total_size,object_key,part_size,part_count,uploaded_parts,status,reserved_bytes,created_at,updated_at,expires_at,file_id,revision_id)
		 VALUES
		   ('upl_seed_open','đang tải.bin','đang tải.bin',NULL,'application/octet-stream',104857600,'objects/fil_open/rev_open',67108864,2,0,'OPEN',104857600,'${isoDate(-1)}','${isoDate(-1)}','${isoDate(1)}','fil_open','rev_open'),
		   ('upl_seed_expired','hết hạn.bin','hết hạn.bin',NULL,'application/octet-stream',52428800,'objects/fil_exp/rev_exp',52428800,1,0,'OPEN',52428800,'${isoDate(-10)}','${isoDate(-10)}','${isoDate(-2)}','fil_exp','rev_exp');`,
	);

	// Quota reservations tương ứng 2 session OPEN.
	sql(
		`INSERT INTO quota_reservations (id,owner_id,upload_session_id,bytes,state,created_at,released_at)
		 VALUES
		   ('qrs_seed_open','own_seed','upl_seed_open',104857600,'HELD','${isoDate(-1)}',NULL),
		   ('qrs_seed_exp','own_seed','upl_seed_exp',52428800,'HELD','${isoDate(-10)}',NULL);`,
	);

	// Recovery codes: 10 mã, 1 đã dùng.
	sql(
		`INSERT INTO recovery_codes (id,owner_id,code_hash,used_at,created_at)
		 VALUES
		   ('rec_seed_1','own_seed','seed-recovery-hash-1',NULL,'${isoDate(-30)}'),
		   ('rec_seed_2','own_seed','seed-recovery-hash-2','${isoDate(-10)}','${isoDate(-30)}');`,
	);

	// Settings + system state + usage.
	sql(
		`INSERT INTO settings (key,value,updated_at) VALUES
		   ('quotaBytes','107374182400','${isoDate(-1)}');`,
	);
	sql(
		`INSERT INTO system_state (key,value,updated_at) VALUES
		   ('quota','{"mode":"NORMAL","reason":"seed","accountRequestsUsed":0,"accountRequestLimit":100000,"alkApiCallsUsed":0,"alkApiBudget":20000,"evaluatedAt":"${iso(-1)}","consecutiveBelow":0,"lastChangedAt":"${iso(-1)}"}','${isoDate(-1)}');`,
	);
	sql(
		`INSERT INTO usage_daily (day,api_calls,uploads_started,uploads_completed,downloads,bytes_uploaded,bytes_downloaded,share_downloads,updated_at)
		 VALUES ('${isoDate(0).slice(0, 10)}',42,3,2,7,1048576,2097152,1,'${isoDate(0)}');`,
	);

	console.log('  ✓ owner, folders, files, shares, sessions, upload_sessions, quota_reservations');
	console.log('  ✓ recovery_codes, settings, system_state, usage_daily');
	console.log('');
	console.log('  Lưu ý: dữ liệu seed là DỮ LIỆU GIẢ — không đăng nhập được, không có object B2.');
	console.log('  Chạy `node --import tsx scripts/restore-drill.ts` để kiểm tra restore với dữ liệu thật.');
}

main();
