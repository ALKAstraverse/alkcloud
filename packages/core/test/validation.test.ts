import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import {
	bootstrapSchema,
	changePasswordSchema,
	fileListQuerySchema,
	folderCreateSchema,
	loginSchema,
	nameSchema,
	recoveryLoginSchema,
	settingsUpdateSchema,
	shareCreateSchema,
	shareUnlockSchema,
	shareUpdateSchema,
	uploadCompleteSchema,
	uploadPartPresignSchema,
	uploadSessionCreateSchema,
	warmUpSchemas,
} from '@alkcloud/core';

describe('validation schemas', () => {
	it('nameSchema chặn rỗng, quá dài, path separator và "." / ".."', () => {
		assert.equal(nameSchema.safeParse('').success, false);
		assert.equal(nameSchema.safeParse('a'.repeat(256)).success, false);
		assert.equal(nameSchema.safeParse('a/b').success, false);
		assert.equal(nameSchema.safeParse('a\\b').success, false);
		assert.equal(nameSchema.safeParse('.').success, false);
		assert.equal(nameSchema.safeParse('..').success, false);
		assert.equal(nameSchema.safeParse('   ').success, false);
		assert.equal(nameSchema.safeParse('file.txt').success, true);
	});

	it('bootstrapSchema yêu cầu setupToken >= 16 và authKey >= 16', () => {
		assert.equal(
			bootstrapSchema.safeParse({
				setupToken: 'short',
				email: 'owner@alkcloud.test',
				authKey: 'k'.repeat(16),
				authVerifierSalt: 'salt-1234',
				authParams: 'params-1234',
			}).success,
			false,
		);
		assert.equal(
			bootstrapSchema.safeParse({
				setupToken: 'setup-token-0123456789',
				email: 'owner@alkcloud.test',
				authKey: 'k'.repeat(16),
				authVerifierSalt: 'salt-1234',
				authParams: 'params-1234',
			}).success,
			true,
		);
	});

	it('email sai định dạng bị chặn', () => {
		assert.equal(loginSchema.safeParse({ email: 'khong-phai-email', authKey: 'k'.repeat(16) }).success, false);
		assert.equal(loginSchema.safeParse({ email: 'owner@alkcloud.test', authKey: 'k'.repeat(16) }).success, true);
	});

	it('fileListQuerySchema coerce limit và áp default', () => {
		const parsed = fileListQuerySchema.parse({});
		assert.equal(parsed.limit, 100);
		assert.equal(parsed.parentId, undefined);
		assert.equal(fileListQuerySchema.parse({ limit: '5' }).limit, 5);
		assert.equal(fileListQuerySchema.safeParse({ limit: 0 }).success, false);
		assert.equal(fileListQuerySchema.safeParse({ limit: 201 }).success, false);
	});

	it('folderCreateSchema default parentId = null', () => {
		assert.equal(folderCreateSchema.parse({ name: 'docs' }).parentId, null);
		assert.equal(folderCreateSchema.parse({ name: 'docs', parentId: null }).parentId, null);
	});

	it('uploadPartPresignSchema giới hạn 20 part/lô và partNumber >= 1', () => {
		assert.equal(uploadPartPresignSchema.safeParse({ uploadId: 'u', partNumbers: [] }).success, false);
		assert.equal(
			uploadPartPresignSchema.safeParse({ uploadId: 'u', partNumbers: Array.from({ length: 21 }, (_, i) => i + 1) })
				.success,
			false,
		);
		assert.equal(
			uploadPartPresignSchema.safeParse({ uploadId: 'u', partNumbers: Array.from({ length: 20 }, (_, i) => i + 1) })
				.success,
			true,
		);
		assert.equal(uploadPartPresignSchema.safeParse({ uploadId: 'u', partNumbers: [0] }).success, false);
	});

	it('uploadCompleteSchema mặc định parts = [] (single-part không cần parts)', () => {
		const parsed = uploadCompleteSchema.parse({});
		assert.deepEqual(parsed.parts, []);
		assert.equal(parsed.uploadId, undefined);
	});

	it('shareCreateSchema giới hạn hạn dùng 1–90 ngày', () => {
		assert.equal(shareCreateSchema.safeParse({ fileId: 'f', expiresInDays: 0 }).success, false);
		assert.equal(shareCreateSchema.safeParse({ fileId: 'f', expiresInDays: 91 }).success, false);
		assert.equal(shareCreateSchema.parse({ fileId: 'f' }).expiresInDays, 7);
		assert.equal(shareCreateSchema.parse({ fileId: 'f' }).maxDownloads, null);
	});

	it('shareUnlockSchema chỉ nhận verifier hex64', () => {
		assert.equal(shareUnlockSchema.safeParse({ passwordVerifier: 'abc' }).success, false);
		assert.equal(shareUnlockSchema.safeParse({ passwordVerifier: 'a'.repeat(64) }).success, true);
	});

	it('recoveryLoginSchema yêu cầu code >= 8 ký tự', () => {
		assert.equal(recoveryLoginSchema.safeParse({ email: 'o@a.co', code: 'short' }).success, false);
		assert.equal(recoveryLoginSchema.safeParse({ email: 'o@a.co', code: 'ABCD-EFGH' }).success, true);
	});

	it('settingsUpdateSchema chỉ nhận URL hợp lệ cho alertWebhookUrl', () => {
		assert.equal(settingsUpdateSchema.safeParse({ alertWebhookUrl: 'not-a-url' }).success, false);
		assert.equal(settingsUpdateSchema.safeParse({ alertWebhookUrl: 'https://example.com/hook' }).success, true);
	});

	it('changePasswordSchema yêu cầu salt/params mới', () => {
		assert.equal(
			changePasswordSchema.safeParse({
				currentAuthKey: 'c'.repeat(16),
				newAuthKey: 'n'.repeat(16),
				newAuthVerifierSalt: 'short',
				newAuthParams: 'params-1234',
			}).success,
			false,
		);
	});
});

describe('warmUpSchemas', () => {
	it('không ném lỗi và gọi lại nhiều lần vẫn an toàn', () => {
		assert.doesNotThrow(() => warmUpSchemas());
		assert.doesNotThrow(() => warmUpSchemas());
	});

	it('sau warm-up, schema vẫn parse đúng', () => {
		warmUpSchemas();
		assert.equal(loginSchema.safeParse({ email: 'owner@alkcloud.test', authKey: 'k'.repeat(16) }).success, true);
		assert.equal(nameSchema.safeParse('file.txt').success, true);
		assert.equal(shareUpdateSchema.safeParse({ expiresInDays: 30 }).success, true);
	});
});
