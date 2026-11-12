import type { AuditAction, AuditSeverity } from '@alkcloud/core';
import type { AppContext } from '../context.js';
import { redactValue } from './redact.js';
import { EVENTS, error as logError } from './observability.js';

/**
 * Phân loại severity. Sự kiện mức `security` và `data_change` LUÔN được ghi,
 * kể cả khi hệ thống đang ở mode degradation (D19).
 */
const SEVERITY_BY_ACTION: Record<AuditAction, AuditSeverity> = {
	'auth.bootstrap': 'security',
	'auth.login.success': 'security',
	'auth.login.failure': 'security',
	'auth.logout': 'security',
	'auth.session.revoke': 'security',
	'auth.session.rotate': 'security',
	'auth.password.change': 'security',
	'auth.recovery_code.use': 'security',
	'auth.recovery_code.reset': 'security',
	'share.unlock': 'security',
	'share.unlock.failure': 'security',
	'share.create': 'data_change',
	'share.update': 'data_change',
	'share.revoke': 'data_change',
	'file.create': 'data_change',
	'file.delete': 'data_change',
	'file.purge': 'data_change',
	'file.restore': 'data_change',
	'file.rename': 'data_change',
	'file.move': 'data_change',
	'folder.create': 'data_change',
	'folder.rename': 'data_change',
	'folder.delete': 'data_change',
	'folder.move': 'data_change',
	'folder.restore': 'data_change',
	'upload.session.create': 'data_change',
	'upload.session.abort': 'data_change',
	'upload.session.expire': 'data_change',
	'system.quota_mode.change': 'system',
	'system.settings.change': 'system',
	'system.key.rotate': 'system',
};

export function severityFor(action: AuditAction): AuditSeverity {
	return SEVERITY_BY_ACTION[action] ?? 'info';
}

export interface AuditInput {
	action: AuditAction;
	actor: string;
	targetType?: string | null;
	targetId?: string | null;
	metadata?: Record<string, unknown>;
	ip?: string | null;
}

export async function recordAudit(
	context: AppContext,
	input: AuditInput,
): Promise<void> {
	const now = context.now().toISOString();
	const entry = {
		id: `aud_${crypto.randomUUID().replace(/-/g, '').slice(0, 24)}`,
		action: input.action,
		severity: severityFor(input.action),
		actor: input.actor,
		targetType: input.targetType ?? null,
		targetId: input.targetId ?? null,
		metadata: input.metadata ?? {},
		ip: input.ip ?? null,
		now,
	};
	try {
		await context.db.appendAudit(entry);
	} catch (error) {
		// Audit KHÔNG được làm hỏng thao tác đã thành công (ví dụ file đã xoá
		// nhưng ghi audit lỗi ⇒ client nhận 500 dù dữ liệu đã thay đổi).
		// Fallback: ghi JSON có cấu trúc ra Workers Logs (retention 3 ngày) để
		// không mất hoàn toàn dấu vết, đồng thời KHÔNG log secret.
		// Mọi giá trị đi qua `redactValue` ⇒ token/pepper/signature không lọt log.
		logError(EVENTS.auditFallback, {
			severity: entry.severity,
			action: entry.action,
			actor: entry.actor,
			targetType: entry.targetType,
			targetId: entry.targetId,
			ip: entry.ip,
			createdAt: entry.now,
			error: redactValue(error),
		});
	}
}
