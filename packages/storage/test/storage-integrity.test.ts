import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import {
	diffStorage,
	exitCodeFor,
	normalizeEtag,
	overallSeverity,
	parseObjectKey,
	type FileMetadata,
	type IntegritySnapshot,
} from '../src/integrity.js';

const NOW = '2026-11-12T00:00:00.000Z';

function file(overrides: Partial<FileMetadata> = {}): FileMetadata {
	return {
		id: 'fil_1',
		name: 'a.txt',
		size: 5,
		objectKey: 'objects/fil_1/rev_1',
		revisionId: 'rev_1',
		etag: 'etag1',
		checksumSha256: 'a'.repeat(64),
		deletedAt: null,
		purgeAfter: null,
		folderId: null,
		...overrides,
	};
}

function snapshot(overrides: Partial<IntegritySnapshot> = {}): IntegritySnapshot {
	return {
		files: [file()],
		uploadSessions: [],
		shares: [],
		objects: [{ key: 'objects/fil_1/rev_1', size: 5, etag: '"etag1"', lastModified: NOW }],
		...overrides,
	};
}

describe('P4 — storage integrity: parseObjectKey', () => {
	it('parse key đúng dạng objects/{fileId}/{revisionId}', () => {
		assert.deepEqual(parseObjectKey('objects/fil_abc/rev_xyz'), {
			fileId: 'fil_abc',
			revisionId: 'rev_xyz',
		});
	});

	it('trả null cho key sai dạng', () => {
		assert.equal(parseObjectKey('objects/fil_abc'), null);
		assert.equal(parseObjectKey('other/fil/rev'), null);
		assert.equal(parseObjectKey('objects//rev'), null);
		assert.equal(parseObjectKey(''), null);
	});
});

describe('P4 — storage integrity: normalizeEtag', () => {
	it('bỏ quote của ETag B2', () => {
		assert.equal(normalizeEtag('"abc123"'), 'abc123');
		assert.equal(normalizeEtag('abc123'), 'abc123');
		assert.equal(normalizeEtag(''), null);
		assert.equal(normalizeEtag(null), null);
	});
});

describe('P4 — storage integrity: phát hiện sai lệch', () => {
	it('trạng thái sạch ⇒ không có finding', () => {
		const report = diffStorage(snapshot(), NOW);
		const meaningful = report.findings.filter((f) => f.kind !== 'checksum_missing');
		assert.equal(meaningful.length, 0, JSON.stringify(meaningful, null, 2));
		assert.equal(overallSeverity(report), 'info');
		assert.equal(exitCodeFor(report), 0);
	});

	it('phát hiện object THIẾU (metadata có, B2 không) — critical', () => {
		const report = diffStorage(snapshot({ objects: [] }), NOW);
		const finding = report.findings.find((f) => f.kind === 'missing_object');
		assert.ok(finding, 'phải có finding missing_object');
		assert.equal(finding.severity, 'critical');
		assert.equal(finding.subject, 'fil_1');
		assert.equal(exitCodeFor(report), 2);
	});

	it('phát hiện object MỒ CÔI (B2 có, metadata không) — low, KHÔNG tự xoá', () => {
		const report = diffStorage(
			snapshot({
				files: [],
				objects: [{ key: 'objects/fil_x/rev_y', size: 10, etag: 'z', lastModified: NOW }],
			}),
			NOW,
		);
		const finding = report.findings.find((f) => f.kind === 'orphan_object');
		assert.ok(finding);
		assert.equal(finding.severity, 'low');
		assert.match(finding.suggestion, /GIỮ|mặc định/);
	});

	it('phát hiện lệch KÍCH THƯỚC — high', () => {
		const report = diffStorage(
			snapshot({
				objects: [{ key: 'objects/fil_1/rev_1', size: 999, etag: '"etag1"', lastModified: NOW }],
			}),
			NOW,
		);
		const finding = report.findings.find((f) => f.kind === 'size_mismatch');
		assert.ok(finding);
		assert.equal(finding.severity, 'high');
		assert.match(finding.detail, /999/);
	});

	it('phát hiện lệch ETAG — high (nhưng bỏ qua ETag multipart d-N)', () => {
		const mismatched = diffStorage(
			snapshot({
				objects: [{ key: 'objects/fil_1/rev_1', size: 5, etag: '"other"', lastModified: NOW }],
			}),
			NOW,
		);
		assert.ok(mismatched.findings.find((f) => f.kind === 'etag_mismatch'));

		// ETag multipart "abc-3" ở D1 vs "abc-3" ở B2 → không phải mismatch.
		const multipart = diffStorage(
			snapshot({
				files: [file({ etag: 'abc-3' })],
				objects: [{ key: 'objects/fil_1/rev_1', size: 5, etag: '"abc-3"', lastModified: NOW }],
			}),
			NOW,
		);
		assert.equal(multipart.findings.filter((f) => f.kind === 'etag_mismatch').length, 0);
	});

	it('phát hiện revision trong metadata lệch với object key — medium', () => {
		const report = diffStorage(
			snapshot({ files: [file({ revisionId: 'rev_OTHER' })] }),
			NOW,
		);
		const finding = report.findings.find((f) => f.kind === 'metadata_missing');
		assert.ok(finding);
		assert.equal(finding.severity, 'medium');
	});

	it('file trong trash CÓ retention ⇒ đánh dấu protected', () => {
		const report = diffStorage(
			snapshot({
				files: [
					file({ deletedAt: '2026-11-01T00:00:00.000Z', purgeAfter: '2026-12-01T00:00:00.000Z' }),
				],
				objects: [],
			}),
			NOW,
		);
		const finding = report.findings.find((f) => f.kind === 'missing_object');
		assert.ok(finding);
		assert.equal(finding.protected, true, 'file trong retention 30 ngày phải được bảo vệ');
	});

	it('file trong trash ĐÃ hết retention ⇒ không protected', () => {
		const report = diffStorage(
			snapshot({
				files: [
					file({ deletedAt: '2026-01-01T00:00:00.000Z', purgeAfter: '2026-02-01T00:00:00.000Z' }),
				],
				objects: [],
			}),
			NOW,
		);
		const finding = report.findings.find((f) => f.kind === 'missing_object');
		assert.ok(finding);
		assert.equal(finding.protected, false);
	});

	it('phát hiện upload session hết hạn còn OPEN — medium', () => {
		const report = diffStorage(
			snapshot({
				uploadSessions: [
					{
						id: 'upl_1',
						fileName: 'big.bin',
						objectKey: 'objects/fil_2/rev_2',
						status: 'OPEN',
						totalSize: 100,
						expiresAt: '2026-11-11T00:00:00.000Z',
						fileId: 'fil_2',
					},
				],
			}),
			NOW,
		);
		const finding = report.findings.find((f) => f.kind === 'stale_upload_session');
		assert.ok(finding);
		assert.equal(finding.severity, 'medium');
	});

	it('upload session còn hạn ⇒ info (bình thường)', () => {
		const report = diffStorage(
			snapshot({
				uploadSessions: [
					{
						id: 'upl_1',
						fileName: 'big.bin',
						objectKey: 'objects/fil_2/rev_2',
						status: 'OPEN',
						totalSize: 100,
						expiresAt: '2026-11-13T00:00:00.000Z',
						fileId: 'fil_2',
					},
				],
			}),
			NOW,
		);
		const finding = report.findings.find((f) => f.kind === 'orphan_upload_session');
		assert.ok(finding);
		assert.equal(finding.severity, 'info');
	});

	it('phát hiện share mồ côi (trỏ file không tồn tại) — medium', () => {
		const report = diffStorage(
			snapshot({
				shares: [{ id: 'shr_1', fileId: 'fil_missing', revokedAt: null, expiresAt: '2026-12-01T00:00:00.000Z' }],
			}),
			NOW,
		);
		const finding = report.findings.find((f) => f.kind === 'orphan_share');
		assert.ok(finding);
		assert.equal(finding.severity, 'medium');
	});

	it('phát hiện file trash thiếu purge_after — medium, protected', () => {
		const report = diffStorage(
			snapshot({
				files: [file({ deletedAt: '2026-11-01T00:00:00.000Z', purgeAfter: null })],
			}),
			NOW,
		);
		const finding = report.findings.find((f) => f.kind === 'trash_protected');
		assert.ok(finding);
		assert.equal(finding.protected, true);
	});

	it('object của upload session ĐANG OPEN không bị coi là mồ côi', () => {
		const report = diffStorage(
			snapshot({
				files: [],
				uploadSessions: [
					{
						id: 'upl_1',
						fileName: 'x.bin',
						objectKey: 'objects/fil_9/rev_9',
						status: 'OPEN',
						totalSize: 1,
						expiresAt: '2026-11-13T00:00:00.000Z',
						fileId: 'fil_9',
					},
				],
				objects: [{ key: 'objects/fil_9/rev_9', size: 1, etag: 'e', lastModified: NOW }],
			}),
			NOW,
		);
		assert.equal(report.findings.filter((f) => f.kind === 'orphan_object').length, 0);
	});
});

describe('P4 — storage integrity: thống kê', () => {
	it('đếm đúng file active/trashed và bytes', () => {
		const report = diffStorage(
			snapshot({
				files: [
					file({ id: 'fil_1', size: 5 }),
					file({ id: 'fil_2', size: 10, deletedAt: '2026-11-01T00:00:00.000Z', purgeAfter: '2026-12-01T00:00:00.000Z' }),
				],
				objects: [
					{ key: 'objects/fil_1/rev_1', size: 5, etag: 'e1', lastModified: NOW },
					{ key: 'objects/fil_2/rev_2', size: 10, etag: 'e2', lastModified: NOW },
				],
			}),
			NOW,
		);
		assert.equal(report.counts.files, 2);
		assert.equal(report.counts.activeFiles, 1);
		assert.equal(report.counts.trashedFiles, 1);
		assert.equal(report.bytes.expectedFromMetadata, 5, 'chỉ tính file active');
		assert.equal(report.bytes.actualInStorage, 15);
		assert.equal(report.bytes.delta, 10);
	});

	it('storageChecked=false ⇒ KHÔNG báo missing_object (tránh critical giả)', () => {
		const report = diffStorage(
			snapshot({ objects: [], storageChecked: false }),
			NOW,
		);
		assert.equal(report.findings.filter((f) => f.kind === 'missing_object').length, 0);
		assert.equal(report.storageChecked, false);
		assert.notEqual(overallSeverity(report), 'critical');
	});

	it('storageChecked=false ⇒ bytes.actualInStorage không dùng làm sự thật', () => {
		const report = diffStorage(snapshot({ objects: [], storageChecked: false }), NOW);
		assert.equal(report.bytes.actualInStorage, 0);
		assert.equal(report.counts.objects, 0);
	});

	it('exit code phản ánh mức nghiêm trọng', () => {
		const clean = diffStorage(snapshot(), NOW);
		assert.equal(exitCodeFor(clean), 0);
		const medium = diffStorage(
			snapshot({
				shares: [{ id: 's', fileId: 'x', revokedAt: null, expiresAt: '2026-12-01T00:00:00.000Z' }],
			}),
			NOW,
		);
		assert.equal(exitCodeFor(medium), 1);
		const critical = diffStorage(snapshot({ objects: [] }), NOW);
		assert.equal(exitCodeFor(critical), 2);
	});
});
