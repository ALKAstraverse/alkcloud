import { AppError, capabilitiesFor } from '@alkcloud/core';
import type { DegradationMode } from '@alkcloud/core';

export type Capability =
	| 'allowNewUploadSession'
	| 'allowPresignMoreParts'
	| 'allowCompleteUpload'
	| 'allowNewShare'
	| 'allowShareUnlock'
	| 'allowPublicShareDownload'
	| 'allowOwnerDownload'
	| 'allowSearch'
	| 'allowStats'
	| 'allowBackgroundJobs'
	| 'allowTrashPurge';

/**
 * Chặn thao tác theo degradation mode.
 * - `complete` luôn được phép (tránh mất dữ liệu upload đang mở).
 * - Audit bảo mật / data change không bao giờ bị chặn ở đây.
 */
export function assertCapability(mode: DegradationMode, capability: Capability, retryAfterSeconds = 60): void {
	const capabilities = capabilitiesFor(mode);
	if (capabilities[capability]) return;
	if (capability === 'allowCompleteUpload') return;
	throw new AppError('quota_exceeded', `Thao tác tạm thời không khả dụng do giới hạn quota (mode=${mode}, capability=${capability}).`, {
		headers: { 'Retry-After': String(retryAfterSeconds), 'x-alkcloud-quota-mode': mode },
	});
}

export function degradationHeaders(mode: DegradationMode): Record<string, string> {
	return {
		'x-alkcloud-quota-mode': mode,
		'x-alkcloud-quota-degraded': mode === 'NORMAL' ? '0' : '1',
	};
}
