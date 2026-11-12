import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { buildManifest, compareManifests, renderMarkdown } from '../release-manifest.js';

/**
 * WS-L2 — kiểm thử release manifest.
 *
 * Bất biến:
 *   R1. Manifest đủ thông tin để owner biết chính xác cái gì sẽ deploy.
 *   R2. Chỉ có TÊN secret, không bao giờ có giá trị.
 *   R3. Migration được liệt kê ĐÚNG THỨ TỰ + checksum.
 *   R4. Phát hiện artifact bị sửa/tam thổ sau khi build.
 *   R5. Markdown sinh ra không rò secret.
 */

describe('WS-L2 — release manifest', () => {
	it('R1 — manifest đủ trường cho release', () => {
		const manifest = buildManifest();
		assert.ok(manifest.version);
		assert.match(manifest.git.commit, /^[0-9a-f]{7,40}$/);
		assert.ok(manifest.generatedAt);
		assert.ok(manifest.deployment.worker === 'alkcloud-api');
		assert.ok(manifest.deployment.routes.includes('api.alk.xx.kg/api/v1/*'));
		assert.ok(manifest.deployment.crons.includes('17 * * * *'));
		assert.ok(manifest.deployment.d1Database === 'alkcloud');
		assert.ok(manifest.deployment.sourceMapsUploaded === false, 'không upload source map');
		assert.ok(manifest.knownBlockers.length >= 4, 'phải nêu blocker đã biết');
	});

	it('R2 — chỉ có TÊN secret, không có giá trị', () => {
		const manifest = buildManifest();
		assert.ok(manifest.requiredSecrets.includes('AUTH_PEPPER'));
		assert.ok(manifest.requiredSecrets.includes('BOOTSTRAP_SETUP_TOKEN'));
		assert.ok(manifest.requiredSecrets.includes('B2_SECRET_ACCESS_KEY'));
		// Không tên nào trông giống giá trị (≥ 20 ký tự liên tục không phải tên).
		for (const secret of manifest.requiredSecrets) {
			assert.match(secret, /^[A-Z][A-Z0-9_]{2,}$/, `tên secret lạ: ${secret}`);
		}
		const json = JSON.stringify(manifest);
		assert.ok(!json.includes('Bearer '), 'không được chứa token');
	});

	it('R3 — migration đúng thứ tự + có checksum', () => {
		const manifest = buildManifest();
		assert.ok(manifest.migrations.length >= 5, 'phải có ít nhất 5 migration');
		const files = manifest.migrations.map((m) => m.file);
		const sorted = [...files].sort();
		assert.deepEqual(files, sorted, 'migration phải theo thứ tự tên');
		assert.ok(files[0]!.endsWith('0001_init.sql'));
		for (const migration of manifest.migrations) {
			assert.match(migration.sha256, /^[0-9a-f]{64}$/);
		}
	});

	it('R4 — phát hiện artifact bị sửa sau khi build', () => {
		const before = buildManifest();
		const after = buildManifest();
		assert.deepEqual(compareManifests(before, after), [], 'manifest không đổi ⇒ không vấn đề');

		// Giả lập artifact bị tam thổ.
		const tampered = JSON.parse(JSON.stringify(before)) as ReturnType<typeof buildManifest>;
		tampered.artifacts[0]!.sha256 = '0'.repeat(64);
		const problems = compareManifests(before, tampered);
		assert.equal(problems.length, 1);
		assert.ok(problems[0]!.includes('checksum khác'));

		// Artifact biến mất.
		const removed = JSON.parse(JSON.stringify(before)) as ReturnType<typeof buildManifest>;
		removed.artifacts.pop();
		assert.ok(compareManifests(before, removed).some((p) => p.includes('biến mất')));

		// Commit khác.
		const otherCommit = JSON.parse(JSON.stringify(before)) as ReturnType<typeof buildManifest>;
		otherCommit.git.commit = 'deadbeefdeadbeefdeadbeefdeadbeefdeadbeef';
		assert.ok(compareManifests(before, otherCommit).some((p) => p.includes('commit khác')));
	});

	it('R5 — markdown sinh ra không rò secret', () => {
		const manifest = buildManifest();
		const markdown = renderMarkdown(manifest);
		assert.ok(markdown.includes('# AlkCloud — Release Manifest'));
		assert.ok(markdown.includes('## 4. Migration'));
		assert.ok(markdown.includes('## 5. Secret bắt buộc'));
		assert.ok(markdown.includes('AUTH_PEPPER'));
		assert.ok(!/AUTH_PEPPER\s*=\s*\S/.test(markdown), 'không được gán giá trị cho secret');
	});
});
