import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { redactSecrets, redactValue } from '../src/lib/redact.js';

describe('P3-M7 — log safety: redact secret', () => {
	it('che giá trị của khoá nhạy cảm dạng key=value', () => {
		const out = redactSecrets('secretAccessKey=abc123def456&bucket=alkcloud-prod');
		assert.ok(!out.includes('abc123def456'), 'giá trị secret phải bị che');
		assert.ok(out.includes('[REDACTED]'), 'phải có marker [REDACTED]');
		assert.ok(out.includes('bucket=alkcloud-prod'), 'khoá thường phải được giữ');
	});

	it('che các khoá nhạy cảm ở dạng JSON', () => {
		const out = redactSecrets('{"authKey":"AAAA","email":"a@b.c"}');
		assert.ok(!out.includes('AAAA'), 'authKey phải bị che');
		assert.ok(out.includes('a@b.c'), 'email (PII) vẫn hiện — chủ động, chỉ che credential');
	});

	it('che chữ ký S3 trong query string', () => {
		const out = redactSecrets(
			'https://s3.example.com/bucket/key?X-Amz-Algorithm=AWS4-HMAC-SHA256&X-Amz-Signature=deadbeefcafe0123',
		);
		assert.ok(!out.includes('deadbeefcafe0123'), 'signature phải bị che');
	});

	it('che Bearer token', () => {
		const out = redactSecrets('Authorization: Bearer eyJhbGciOiJIUzI1NiJ9.payload.sig');
		assert.ok(!out.includes('eyJhbGciOiJIUzI1NiJ9'), 'bearer token phải bị che');
		assert.ok(out.toLowerCase().includes('authorization'), 'vẫn nhận biết là header Authorization');
	});

	it('không che nhầm ETag/hex ngắn trong log hợp lệ', () => {
		const etag = '"etag":"d41d8cd98f00b204e9800998ecf8427e"';
		const out = redactSecrets(etag);
		assert.ok(out.includes('d41d8cd98f00b204e9800998ecf8427e'), 'ETag không phải secret');
	});

	it('redactValue với Error chỉ giữ name/message (đã redact)', () => {
		const error = new Error('request failed with token=supersecretvalue123');
		const out = redactValue(error) as { name: string; message: string };
		assert.equal(out.name, 'Error');
		assert.ok(!out.message.includes('supersecretvalue123'), 'message phải được redact');
	});

	it('redactValue bỏ khoá nhạy cảm trong object lồng nhau', () => {
		const out = redactValue({
			bucket: 'alkcloud-prod',
			credentials: { secretAccessKey: 'topsecretvalue' },
			list: ['ok', 'password=hunter2'],
		}) as Record<string, unknown>;
		assert.equal(out.bucket, 'alkcloud-prod');
		const credentials = out.credentials as Record<string, unknown>;
		assert.equal(credentials.secretAccessKey, '[REDACTED]');
		const list = out.list as string[];
		assert.ok(!list[1]!.includes('hunter2'), 'phần tử mảng phải được redact');
	});

	it('giới hạn độ sâu để không log cây object vô hạn', () => {
		let deep: Record<string, unknown> = { value: 'leaf' };
		for (let i = 0; i < 10; i++) deep = { nested: deep };
		const out = JSON.stringify(redactValue(deep));
		assert.ok(out.includes('TRUNCATED'), 'phải cắt bớt chiều sâu');
	});

	it('giá trị null/undefined không lỗi', () => {
		assert.equal(redactValue(null), null);
		assert.equal(redactValue(undefined), undefined);
	});
});
