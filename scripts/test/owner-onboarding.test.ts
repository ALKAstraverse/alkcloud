import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { rmSync, existsSync, readFileSync, statSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { aggregateStatus, generateLocalSecrets, parseCheckOutput } from '../owner-onboarding.js';

/**
 * WS-L2/M13 — kiểm thử owner onboarding CLI.
 *
 * Bất biến:
 *   O1. Parse output chuẩn của `infra/check-*.sh` đúng.
 *   O2. Trạng thái tổng hợp = điểm yếu nhất (fail > denied > not_configured > skipped > pass).
 *   O3. Sinh secret cục bộ: file mode 600, KHÔNG in giá trị, idempotent (không ghi đè).
 *   O4. File secret nằm trong `deploy/` (gitignored) ⇒ không bị commit.
 */

const ROOT = resolve(fileURLToPath(new URL('../..', import.meta.url)));
const LOCAL_SECRETS_FILE = join(ROOT, 'deploy/local-secrets.env');

describe('WS-L2/M13 — owner onboarding', () => {
	it('O1 — parse output chuẩn của check script', () => {
		const output = [
			'PASS              zone:read — đọc được (/zones/abc)',
			'NOT_CONFIGURED    dns:cloud.alk.xx.kg — chưa có record A/CNAME (xem docs/20 §B7)',
			'PERMISSION_DENIED account:analytics:read — bị từ chối: authorization denied',
			'FAIL              database_id — còn placeholder',
			'SKIPPED           gateway:api-gateway — cần xác nhận sau khi deploy',
			'',
			'Tổng kết: PASS=1 FAIL=1 ...',
		].join('\n');
		const lines = parseCheckOutput(output);
		assert.equal(lines.length, 5);
		assert.deepEqual(
			lines.map((l) => l.status),
			['pass', 'not_configured', 'permission_denied', 'fail', 'skipped'],
		);
		assert.equal(lines[0]!.name, 'zone:read');
		assert.equal(lines[0]!.detail, 'đọc được (/zones/abc)');
		assert.equal(lines[1]!.name, 'dns:cloud.alk.xx.kg');
		assert.ok(lines[1]!.detail.includes('docs/20 §B7'));
	});

	it('O2 — trạng thái tổng hợp = điểm yếu nhất', () => {
		assert.equal(aggregateStatus([]), 'unknown');
		assert.equal(aggregateStatus([{ status: 'pass', name: 'a', detail: '' }]), 'pass');
		assert.equal(
			aggregateStatus([
				{ status: 'pass', name: 'a', detail: '' },
				{ status: 'not_configured', name: 'b', detail: '' },
			]),
			'not_configured',
		);
		assert.equal(
			aggregateStatus([
				{ status: 'not_configured', name: 'b', detail: '' },
				{ status: 'permission_denied', name: 'c', detail: '' },
			]),
			'permission_denied',
		);
		assert.equal(
			aggregateStatus([
				{ status: 'pass', name: 'a', detail: '' },
				{ status: 'fail', name: 'd', detail: '' },
			]),
			'fail',
		);
	});

	it('O3 — sinh secret cục bộ: mode 600, không ghi đè, không lộ giá trị', () => {
		// Dọn trạng thái cũ để test độc lập với lần chạy trước.
		const existedBefore = existsSync(LOCAL_SECRETS_FILE);
		if (existedBefore) rmSync(LOCAL_SECRETS_FILE);
		const first = generateLocalSecrets();
		assert.deepEqual(first.created.sort(), ['AUTH_PEPPER', 'BOOTSTRAP_SETUP_TOKEN']);
		assert.equal(first.kept.length, 0);
		assert.ok(existsSync(LOCAL_SECRETS_FILE));

		// Mode 600 ⇒ chỉ owner đọc được.
		const mode = statSync(LOCAL_SECRETS_FILE).mode & 0o777;
		assert.equal(mode, 0o600, `mode phải là 600, thực tế ${mode.toString(8)}`);

		// Không có giá trị rỗng; giá trị đủ dài.
		const content = readFileSync(LOCAL_SECRETS_FILE, 'utf8');
		const values = content
			.split('\n')
			.filter((line) => line.includes('=') && !line.trimStart().startsWith('#'))
			.map((line) => line.split('=', 2)[1]!.trim());
		assert.equal(values.length, 2);
		for (const value of values) {
			assert.ok(value.length >= 32, 'pepper/token phải đủ dài');
		}

		// Idempotent: chạy lại KHÔNG sinh lại (giữ nguyên pepper ⇒ không phá phiên).
		const second = generateLocalSecrets();
		assert.equal(second.created.length, 0);
		assert.deepEqual(second.kept.sort(), ['AUTH_PEPPER', 'BOOTSTRAP_SETUP_TOKEN']);
		assert.equal(readFileSync(LOCAL_SECRETS_FILE, 'utf8'), content, 'file không được đổi');

		// Dọn file test sinh ra (tránh để lại pepper "mồ côi" cho owner).
		if (!existedBefore) rmSync(LOCAL_SECRETS_FILE);
	});

	it('O4 — file secret nằm trong thư mục gitignored', () => {
		const gitignore = readFileSync(join(ROOT, '.gitignore'), 'utf8');
		assert.ok(gitignore.includes('deploy/'), 'deploy/ phải nằm trong .gitignore');
		// File chứa secret không được được track bởi git.
		const tracked = execFileSync('git', ['ls-files', 'deploy/'], { cwd: ROOT, encoding: 'utf8' }).trim();
		assert.equal(tracked, '', 'deploy/ không được có file nào bị track');
	});
});
