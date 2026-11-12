import { newId, randomToken, sha256Hex } from '@alkcloud/core';

export const RECOVERY_CODE_COUNT = 10;
export const RECOVERY_CODE_BYTES = 10; // ~80-bit entropy mỗi mã

export interface RecoveryCodeMaterial {
	id: string;
	code: string;
	codeHash: string;
}

/** Mã khôi phục dạng `XXXX-XXXX-XXXX` (base32-ish, dễ gõ). */
export function formatRecoveryCode(raw: string): string {
	const normalized = raw.replace(/[^a-z0-9]/gi, '').toUpperCase().slice(0, 12);
	return normalized.replace(/(.{4})(?=.)/g, '$1-');
}

export function generateRecoveryCodes(
	pepper: string,
	count = RECOVERY_CODE_COUNT,
): RecoveryCodeMaterial[] {
	const codes: RecoveryCodeMaterial[] = [];
	for (let index = 0; index < count; index++) {
		const raw = randomToken(RECOVERY_CODE_BYTES);
		const code = formatRecoveryCode(raw);
		codes.push({ id: newId('rec'), code, codeHash: '' });
	}
	return codes;
}

/** Hash mã khôi phục có pepper để dump DB không dùng được offline. */
export async function hashRecoveryCode(code: string, pepper: string): Promise<string> {
	return sha256Hex(`${code.replace(/[-\s]/g, '').toUpperCase()}${pepper}`);
}
