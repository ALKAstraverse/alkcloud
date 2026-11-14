import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, it } from 'node:test';

import { CONTENT_SECURITY_POLICY } from '../src/worker.ts';

/**
 * WS-L — CSP phải có **một nguồn duy nhất**.
 *
 * Sự cố đã gặp (14/11/2026): Cloudflare Static Assets phục vụ `/` và `/assets/*`
 * **không** gọi Worker ⇒ header lấy từ `public/_headers`. Worker đã sửa CSP nhưng
 * `_headers` còn giá trị cũ ⇒ các path đó trả CSP cũ ⇒ console báo CSP violation
 * (beacon của Cloudflare Web Analytics bị chặn) ⇒ file bị user tưởng "lỗi".
 *
 * Hai nơi khai CSP (Worker + `_headers`) ⇒ dễ lệch ⇒ test này chốt chúng khớp nhau.
 */

const here = fileURLToPath(new URL('.', import.meta.url));
const headersFile = join(here, '..', 'public', '_headers');

function normalize(value: string): string {
	return value.replace(/\s+/g, ' ').trim();
}

describe('WS-L — CSP đồng bộ giữa Worker và public/_headers', () => {
	it('`_headers` khai đúng CSP như Worker', () => {
		const text = readFileSync(headersFile, 'utf8');
		const match = text.match(/^\s*Content-Security-Policy:\s*(.+)$/m);
		assert.ok(match, 'phải có Content-Security-Policy trong public/_headers');
		assert.equal(
			normalize(match[1]!),
			normalize(CONTENT_SECURITY_POLICY),
			'CSP trong public/_headers KHÁC CSP trong src/worker.ts ⇒ path phục vụ trực tiếp ' +
				'by Static Assets sẽ trả CSP cũ (gây CSP violation). Sửa cả hai cho khớp.',
		);
	});

	it('CSP cho phép các host bắt buộc', () => {
		assert.match(CONTENT_SECURITY_POLICY, /script-src[^;]*https:\/\/static\.cloudflareinsights\.com/);
		assert.match(CONTENT_SECURITY_POLICY, /connect-src[^;]*https:\/\/api\.alk\.xx\.kg/);
		assert.match(CONTENT_SECURITY_POLICY, /connect-src[^;]*https:\/\/s3\.ca-east-006\.backblazeb2\.com/);
	});

	it('CSP không nới lỏng script (không unsafe-inline/eval)', () => {
		const scriptSrc = CONTENT_SECURITY_POLICY.match(/script-src([^;]*)/)?.[1] ?? '';
		assert.ok(!scriptSrc.includes("'unsafe-inline'"), "script-src KHÔNG được có 'unsafe-inline'");
		assert.ok(!scriptSrc.includes("'unsafe-eval'"), "script-src KHÔNG được có 'unsafe-eval'");
	});
});
