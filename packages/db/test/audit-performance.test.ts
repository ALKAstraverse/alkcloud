import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { createTestDb, OWNER_INPUT } from './helpers.js';

/**
 * WS-G — hồi quy hiệu năng + tính đúng đắn của đường đọc audit.
 *
 * `listAudit` được viết lại (migration 0004) để dẫn đường từ `audit_chain`
 * thay vì `LEFT JOIN` + `ORDER BY COALESCE(...)`. Bản cũ quét O(n×m) và sort
 * toàn bộ tập kết quả ⇒ nhanh chóng thành đường chậm nhất của API.
 *
 * Các test này khóa lại CẢ tính đúng đắn (thứ tự chain, dòng mồ côi vẫn hiện)
 * LẪN hình dạng câu truy vấn (index được dùng, không full-scan).
 */
describe('WS-G — listAudit', () => {
	it('trả về event theo đúng thứ tự chuỗi hash (seq giảm dần)', async () => {
		const { db } = await createTestDb();
		await db.createOwner(OWNER_INPUT);
		for (let index = 0; index < 5; index++) {
			await db.appendAudit({
				id: `aud_${index}`,
				action: 'file.create',
				severity: 'info',
				actor: 'owner@alkcloud.test',
				targetType: 'file',
				targetId: `fil_${index}`,
				metadata: { index },
				ip: '127.0.0.1',
				now: `2026-01-01T00:00:0${index}.000Z`,
			});
		}
		const events = await db.listAudit(10);
		assert.equal(events.length, 5);
		// Mới nhất (seq cao nhất) phải đứng đầu.
		assert.deepEqual(
			events.map((event) => event.id),
			['aud_4', 'aud_3', 'aud_2', 'aud_1', 'aud_0'],
		);
	});

	it('giới hạn số event trả về theo LIMIT', async () => {
		const { db } = await createTestDb();
		await db.createOwner(OWNER_INPUT);
		for (let index = 0; index < 10; index++) {
			await db.appendAudit({
				id: `aud_${index}`,
				action: 'file.create',
				severity: 'info',
				actor: 'owner@alkcloud.test',
				targetType: 'file',
				targetId: `fil_${index}`,
				metadata: {},
				ip: null,
				now: `2026-01-01T00:00:0${index}.000Z`,
			});
		}
		const events = await db.listAudit(3);
		assert.equal(events.length, 3);
		assert.deepEqual(events.map((event) => event.id), ['aud_9', 'aud_8', 'aud_7']);
	});

	it('dòng audit KHÔNG có entry trong chain vẫn hiển thị (phòng thủ)', async () => {
		const { db, driver } = await createTestDb();
		await db.createOwner(OWNER_INPUT);
		await db.appendAudit({
			id: 'aud_chained',
			action: 'file.create',
			severity: 'info',
			actor: 'owner@alkcloud.test',
			targetType: 'file',
			targetId: 'fil_1',
			metadata: {},
			ip: null,
			now: '2026-01-01T00:00:00.000Z',
		});
		// Mồ côi: có trong audit_logs nhưng không có trong audit_chain.
		await driver.run(
			`INSERT INTO audit_logs (id, action, severity, actor, target_type, target_id, metadata, ip, created_at, prev_hash, entry_hash)
			 VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
			[
				'aud_orphan',
				'file.create',
				'info',
				'owner@alkcloud.test',
				'file',
				'fil_2',
				'{}',
				null,
				'2026-01-01T00:00:01.000Z',
				'GENESIS',
				'orphan-entry-hash',
			],
		);
		const events = await db.listAudit(10);
		const ids = events.map((event) => event.id);
		assert.ok(ids.includes('aud_chained'), 'event có chain phải hiện');
		assert.ok(ids.includes('aud_orphan'), 'event mồ côi phải hiện');
		// Event có chain nằm TRƯỚC event mồ côi (seq = -1 ⇒ cuối).
		assert.ok(ids.indexOf('aud_chained') < ids.indexOf('aud_orphan'));
	});

	it('truy vấn dùng index (không full-scan audit_chain)', async () => {
		const { db, driver } = await createTestDb();
		await db.createOwner(OWNER_INPUT);
		for (let index = 0; index < 5; index++) {
			await db.appendAudit({
				id: `aud_${index}`,
				action: 'file.create',
				severity: 'info',
				actor: 'owner@alkcloud.test',
				targetType: 'file',
				targetId: `fil_${index}`,
				metadata: {},
				ip: null,
				now: `2026-01-01T00:00:0${index}.000Z`,
			});
		}
		const plan = await driver.query<{ detail: string }>(
			'EXPLAIN QUERY PLAN SELECT l.* FROM audit_chain c JOIN audit_logs l ON l.entry_hash = c.entry_hash ORDER BY c.seq DESC LIMIT 10',
		);
		const details = plan.rows.map((row) => row.detail).join(' | ');
		// Không được quét toàn bộ bảng (`SCAN audit_chain` / `SCAN audit_logs`).
		assert.ok(!/SCAN audit_chain\b/.test(details), `query plan phải dùng index: ${details}`);
		assert.ok(!/SCAN audit_logs\b/.test(details), `query plan phải dùng index: ${details}`);
	});
});
