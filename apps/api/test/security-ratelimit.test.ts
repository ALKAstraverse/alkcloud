import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { createWorkerHarness } from './worker-harness.js';
import { AUTH_KEY } from './harness.js';

/**
 * Phase 4 — SEC-01: rate limiter phải thực sự hoạt động trên đường production.
 *
 * Bug gốc: `apps/api/src/index.ts` dựng lại `createApp()` cho MỖI request ⇒ mỗi
 * `MemoryRateLimiter` bị tạo mới (rỗng) ⇒ rate limit KHÔNG BAO GIỜ kích hoạt.
 * Test cũ (`apps/api/test/api.test.ts`) dựng app 1 lần nên không bắt được.
 *
 * Bộ test này đi qua `createWorkerApp()` — đúng đường code production.
 */
describe('SEC-01 — rate limiter hoạt động trên đường production', () => {
	it('đăng nhập sai 5 lần ⇒ lần 6 bị chặn 429 (không phải 401)', async () => {
		const harness = await createWorkerHarness();
		try {
			const statuses: number[] = [];
			for (let attempt = 0; attempt < 6; attempt++) {
				const response = await harness.request('/auth/login', {
					method: 'POST',
					body: { email: 'owner@alkcloud.test', authKey: 'wrong-auth-key-000000000000' },
					cookie: '',
				});
				statuses.push(response.status);
			}
			assert.equal(statuses[0], 401, 'lần đầu phải là 401 (sai mật khẩu)');
			assert.ok(
				statuses.includes(429),
				`phải có 429 sau nhiều lần thử sai, thực tế: ${statuses.join(',')}`,
			);
			assert.equal(statuses[5], 429, 'lần thứ 6 phải bị chặn');
		} finally {
			harness.close();
		}
	});

	it('rate limit có trạng thái giữa các request (không phải mỗi request một limiter)', async () => {
		const harness = await createWorkerHarness();
		try {
			for (let attempt = 0; attempt < 3; attempt++) {
				await harness.request('/auth/login', {
					method: 'POST',
					body: { email: 'owner@alkcloud.test', authKey: 'wrong-auth-key-000000000000' },
					cookie: '',
				});
			}
			// Request thứ 4 và 5 cũng phải dùng CHUNG bucket với 3 lần trước.
			const fourth = await harness.request('/auth/login', {
				method: 'POST',
				body: { email: 'owner@alkcloud.test', authKey: 'wrong-auth-key-000000000000' },
				cookie: '',
			});
			const fifth = await harness.request('/auth/login', {
				method: 'POST',
				body: { email: 'owner@alkcloud.test', authKey: 'wrong-auth-key-000000000000' },
				cookie: '',
			});
			assert.equal(fourth.status, 401);
			assert.equal(fifth.status, 401);
			const sixth = await harness.request('/auth/login', {
				method: 'POST',
				body: { email: 'owner@alkcloud.test', authKey: 'wrong-auth-key-000000000000' },
				cookie: '',
			});
			assert.equal(sixth.status, 429, 'lần 6 phải bị chặn — bucket phải dùng chung');
		} finally {
			harness.close();
		}
	});

	it('đăng nhập sai với email KHÁC vẫn bị chặn (không bypass được bằng cách đổi email)', async () => {
		const harness = await createWorkerHarness();
		try {
			for (let attempt = 0; attempt < 5; attempt++) {
				await harness.request('/auth/login', {
					method: 'POST',
					body: { email: `attacker-${attempt}@evil.test`, authKey: 'wrong-auth-key-000000000000' },
					cookie: '',
				});
			}
			const response = await harness.request('/auth/login', {
				method: 'POST',
				body: { email: 'attacker-99@evil.test', authKey: 'wrong-auth-key-000000000000' },
				cookie: '',
			});
			assert.equal(response.status, 429, 'phải chặn theo IP, không theo email');
		} finally {
			harness.close();
		}
	});

	it('đăng nhập ĐÚNG vẫn thành công (rate limit không chặn owner hợp lệ)', async () => {
		const harness = await createWorkerHarness();
		try {
			const response = await harness.request('/auth/login', {
				method: 'POST',
				body: { email: 'owner@alkcloud.test', authKey: AUTH_KEY },
				cookie: '',
			});
			assert.equal(response.status, 200);
		} finally {
			harness.close();
		}
	});
});
