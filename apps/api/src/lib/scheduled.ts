import type { Database } from '@alkcloud/db';
import type { ObjectStorage } from '@alkcloud/storage';
import {
	AppError,
	DEFAULT_DAILY_API_BUDGET,
	evaluateQuota,
	initialQuotaState,
	msFromIso,
	TRASH_RETENTION_DAYS,
	utcDateKey,
} from '@alkcloud/core';
/** Thời gian giữ audit log (ngày). `audit_chain` được giữ vĩnh viễn. */
export const AUDIT_RETENTION_DAYS = 180;
/**
 * Grace period của purge 2 pha (giờ). Sau khi đánh dấu `PENDING`, object ở storage
 * còn nguyên trong khoảng này ⇒ owner restore được ⇒ huỷ purge (AUD-01).
 */
export const PURGE_GRACE_PERIOD_MS = 24 * 60 * 60 * 1000;
/**
 * Tên script Worker của AlkCloud — dùng để lọc số request của RIÊNG app
 * trong Cloudflare analytics (BUG-12: lọc client-side không hoạt động vì
 * Worker chạy qua route bị gom vào nhóm `__unknown__`).
 */
export const WORKER_SCRIPT_NAME = 'alkcloud-api';

import { sweepAllLimiters } from '@alkcloud/auth';
import type { Env, ResolvedConfig } from '../env.js';
import { readQuotaState, writeQuotaState } from '../context.js';
import { recordAudit } from './audit.js';
import { EVENTS, error as logError, info as logInfo } from './observability.js';

export interface ScheduledDeps {
	db: Database;
	storage: ObjectStorage;
	config: ResolvedConfig;
	env: Env;
	scheduledTime: number;
}

/**
 * Cron job của Worker.
 * - Không được tạo tài nguyên mới.
 * - Khi hệ thống đang ở mode degradation (READ_ONLY/EMERGENCY) thì BỎ QUA các
 *   tác vụ nền (cleanup/purge) — không cleanup upload session/multipart đang mở.
 */
export async function runScheduledTasks(deps: ScheduledDeps): Promise<void> {
	const startedAt = Date.now();
	try {
		await runScheduledTasksInner(deps, startedAt);
	} catch (caught) {
		// Cron hỏng KHÔNG được im lặng: ghi log có cấu trúc + heartbeat `error`
		// để owner thấy ngay qua `GET /system/diagnostics`.
		logError(EVENTS.cronFailed, {
			durationMs: Date.now() - startedAt,
			errorName: caught instanceof Error ? caught.name : 'unknown',
			errorCode: caught instanceof Error ? (caught as { code?: string }).code : undefined,
		});
		try {
			await deps.db.setHealthHeartbeat({
				status: 'error',
				updatedAt: new Date().toISOString(),
				data: {
					errorName: caught instanceof Error ? caught.name : 'unknown',
					durationMs: Date.now() - startedAt,
				},
			});
		} catch {
			// Không ghi được heartbeat thì không ghi thêm log (tránh loop).
		}
		throw caught;
	}
}

async function runScheduledTasksInner(deps: ScheduledDeps, startedAt: number): Promise<void> {
	const { db, config, scheduledTime } = deps;
	const state = await readQuotaState(db, config.quotaStateTtlSeconds, scheduledTime);
	const mode = state?.mode ?? 'NORMAL';

	// 1. Dọn session/idempotency hết hạn (an toàn kể cả khi degraded).
	// Dùng `scheduledTime` (mốc cron được Cloudflare giao) làm "hiện tại" —
	// nhất quán với phần còn lại của cron và giúp test có đồng hồ cố định.
	const now = new Date(scheduledTime).toISOString();
	await db.deleteExpiredSessions(now);
	await db.deleteExpiredIdempotency(now);

	// 1b. Cắt bớt audit log cũ (SEC-04) — bảng này không có retention nên phình
	//     vô hạn. GIỮ NGUYÊN `audit_chain` (chuỗi hash không được đứt).
	//     Retention 180 ngày — đủ cho điều tra sự cố cá nhân.
	await db.pruneAuditLogs(new Date(new Date(now).getTime() - AUDIT_RETENTION_DAYS * 24 * 60 * 60 * 1000).toISOString());

	// 1c. Dọn bucket rate limiter hết hạn (SEC-15) — nếu không, mỗi key IP
	//     khác nhau giữ một entry vô thời hạn trong RAM của isolate.
	sweepAllLimiters(scheduledTime);

	// 2. Dọn upload session hết hạn + multipart tương ứng (CHỈ khi mode = NORMAL).
	if (mode === 'NORMAL') {
		const expired = await db.listExpiredUploadSessions(now, 50);
		for (const session of expired) {
			try {
				const versions = await deps.storage.listObjectVersions(session.objectKey);
				for (const version of versions) {
					await deps.storage.deleteObjectVersion(session.objectKey, version.versionId);
				}
				await deps.storage.deleteObject(session.objectKey);
			} catch {
				// B2 chưa cấu hình hoặc lỗi tạm thời: giữ session, thử lại ở cron sau.
				continue;
			}
			await db.setUploadSessionStatus(session.id, 'EXPIRED', now);
			await db.releaseQuota(session.id, now);
			await recordAudit({ db, storage: deps.storage, config, now: () => new Date(scheduledTime) }, {
				action: 'upload.session.expire',
				actor: 'cron',
				targetType: 'upload_session',
				targetId: session.id,
			});
		}
	}

	// 2b. Release quota reservation **mồ côi** (AUD-04): reservation không gắn với
	//     session OPEN nào (session đã hoàn tất/abort/bị xoá, hoặc tạo session lỗi).
	//     Trước đây reservation mồ côi giữ quota vĩnh viễn ⇒ owner không upload được.
	await db.releaseOrphanQuotaReservations(now);

	// 3. Purge file đã hết retention 30 ngày (CHỈ khi mode = NORMAL) — **2 pha**.
	//
	// Pha 1 (mark): đánh dấu `PENDING`, object ở storage **CÒN NGUYÊN** ⇒ owner vẫn
	// restore được trong grace period ⇒ huỷ purge. Trước đây cron xoá object ngay
	// khi hết hạn ⇒ file vừa restore là mất vĩnh viễn (AUD-01).
	//
	// Pha 2 (execute): sau grace period ⇒ đánh dấu `PURGING` (restore bị từ chối) ⇒
	// xoá object ở storage ⇒ xoá row D1 **có điều kiện**. Nếu xoá object lỗi ⇒ trả
	// state về `NONE` (object còn nguyên ⇒ restore an toàn) và thử lại ở cron sau.
	if (mode === 'NORMAL') {
		await db.markFilesPendingPurge(now, 50);
		const graceCutoff = new Date(new Date(now).getTime() - PURGE_GRACE_PERIOD_MS).toISOString();
		const ready = await db.listFilesReadyForPurge(graceCutoff, 20);
		for (const file of ready) {
			const activeShares = await db.countActiveShares(file.id, now);
			if (activeShares > 0) continue;
			if (file.purgeState !== 'PURGING') {
				const started = await db.markFilePurgeStarted(file.id, now);
				if (!started) continue;
			}
			try {
				const versions = await deps.storage.listObjectVersions(file.objectKey);
				for (const version of versions) {
					await deps.storage.deleteObjectVersion(file.objectKey, version.versionId);
				}
				if (versions.length === 0) await deps.storage.deleteObject(file.objectKey);
			} catch {
				await db.cancelFilePurge(file.id, now);
				continue;
			}
			const deleted = await db.deleteFileRowIfStillTrashed(file.id, now);
			if (!deleted) {
				logError(EVENTS.cronFailed, {
					fileId: file.id,
					reason: 'purge_state_changed',
				});
				continue;
			}
			await recordAudit({ db, storage: deps.storage, config, now: () => new Date(scheduledTime) }, {
				action: 'file.purge',
				actor: 'cron',
				targetType: 'file',
				targetId: file.id,
				metadata: { objectKey: file.objectKey, reason: 'retention_expired' },
			});
		}
		const folderCutoff = new Date(new Date(now).getTime() - TRASH_RETENTION_DAYS * 24 * 60 * 60 * 1000).toISOString();
		await db.purgeDeletedFolders(folderCutoff);
	}

	// 4. Cập nhật trạng thái quota nếu có dữ liệu analytics (token chưa cấu hình => giữ nguyên mode).
	const snapshot = await collectQuotaSnapshot(deps, state, scheduledTime);
	const next = evaluateQuota(
		state
			? {
					mode: state.mode,
					consecutiveBelow: state.consecutiveBelow,
					lastChangedAtMs: msFromIso(state.lastChangedAt),
					reason: state.reason,
				}
			: initialQuotaState(scheduledTime),
		snapshot,
		scheduledTime,
	);
	// PHẢI ghi lại state khi `consecutiveBelow` thay đổi, không chỉ khi mode đổi:
	// bộ đếm hysteresis (3 chu kỳ dưới ngưỡng exit) nằm trong DB. Nếu chỉ ghi
	// khi mode đổi thì bộ đếm luôn = 0 ⇒ hệ thống KHÔNG BAO GIỜ tự hồi phục
	// (mắc kẹt ở mode degraded vĩnh viễn sau khi leo thang).
	const consecutiveChanged = next.consecutiveBelow !== (state?.consecutiveBelow ?? 0);
	if (next.changed || consecutiveChanged || !state) {
		const owner = await db.getOwner();
		// `lastChangedAt` là mốc lần ĐỔI MODE gần nhất (dùng cho cooldown) —
		// không được reset khi chỉ cập nhật bộ đếm, nếu không cooldown 30′
		// không bao giờ hết.
		const lastChangedAt = next.changed
			? new Date(scheduledTime).toISOString()
			: (state?.lastChangedAt ?? new Date(scheduledTime).toISOString());
		await writeQuotaState(
			db,
			{
				mode: next.mode,
				reason: next.reason,
				accountRequestsUsed: snapshot.accountRequestsUsed,
				accountRequestLimit: snapshot.accountRequestLimit,
				alkApiCallsUsed: snapshot.alkApiCallsUsed,
				alkApiBudget: snapshot.alkApiBudget,
				evaluatedAt: new Date(scheduledTime).toISOString(),
				consecutiveBelow: next.consecutiveBelow,
				lastChangedAt,
				updatedAt: new Date(scheduledTime).toISOString(),
			},
			new Date(scheduledTime).toISOString(),
		);
		if (owner && next.changed) {
			await recordAudit({ db, storage: deps.storage, config, now: () => new Date(scheduledTime) }, {
				action: 'system.quota_mode.change',
				actor: 'cron',
				targetType: 'system',
				targetId: 'quota',
				metadata: { from: state?.mode ?? 'NORMAL', to: next.mode, reason: next.reason },
			});
			logInfo(EVENTS.quotaModeChanged, { from: state?.mode ?? 'NORMAL', to: next.mode });
		}
	}

	// 5. Heartbeat sức khoẻ (WS-K) — 1 dòng trong D1, UPSERT.
	//    Cho owner biết cron có chạy không mà không cần đào Workers Logs (3 ngày).
	await db.setHealthHeartbeat({
		status: 'ok',
		updatedAt: new Date(scheduledTime).toISOString(),
		data: {
			durationMs: Date.now() - startedAt,
			mode: next.mode,
			quotaDataAvailable: snapshot.dataAvailable,
			accountRequestsUsed: snapshot.accountRequestsUsed,
			accountRequestLimit: snapshot.accountRequestLimit,
			alkApiCallsUsed: snapshot.alkApiCallsUsed,
			alkApiBudget: snapshot.alkApiBudget,
			consecutiveBelow: next.consecutiveBelow,
			storageCircuit: storageCircuitState(deps.storage),
		},
	});
}

/**
 * Trạng thái circuit breaker của lớp lưu trữ (null nếu adapter không có).
 * Cho phép owner thấy "B2 đang chết" mà không cần đọc log.
 */
function storageCircuitState(storage: unknown): string | null {
	const candidate = storage as { getCircuitState?: () => string };
	return typeof candidate.getCircuitState === 'function' ? candidate.getCircuitState() : null;
}

interface QuotaSnapshotInput {
	accountRequestsUsed: number;
	accountRequestLimit: number;
	alkApiCallsUsed: number;
	alkApiBudget: number;
	dataAvailable: boolean;
}

/**
 * Thu thập số liệu quota.
 * - `CLOUDFLARE_ANALYTICS_TOKEN` (Worker secret) chưa cấu hình => dataAvailable=false,
 *   hệ thống GIỮ NGUYÊN mode (không tự hạ bậc) theo nguyên tắc fail-safe.
 */
async function collectQuotaSnapshot(
	deps: ScheduledDeps,
	state: { accountRequestsUsed: number; accountRequestLimit: number; alkApiCallsUsed: number; alkApiBudget: number } | null,
	nowMs: number,
): Promise<QuotaSnapshotInput> {
	const budget = deps.config.dailyApiBudget || DEFAULT_DAILY_API_BUDGET;
	const limit = deps.config.accountDailyRequestLimit;
	const day = utcDateKey(nowMs);
	const usage = await deps.db.getUsageDaily(day);
	const analyticsToken = deps.env.CLOUDFLARE_ANALYTICS_TOKEN;

	if (!analyticsToken) {
		return {
			accountRequestsUsed: state?.accountRequestsUsed ?? 0,
			accountRequestLimit: limit,
			alkApiCallsUsed: state?.alkApiCallsUsed ?? usage?.api_calls ?? 0,
			alkApiBudget: state?.alkApiBudget ?? budget,
			dataAvailable: false,
		};
	}

	try {
		const accountId = deps.env.CLOUDFLARE_ACCOUNT_ID;
		if (!accountId) throw new AppError('not_configured', 'thiếu CLOUDFLARE_ACCOUNT_ID');
		const response = await fetch('https://api.cloudflare.com/client/v4/graphql', {
			method: 'POST',
			headers: {
				Authorization: `Bearer ${analyticsToken}`,
				'Content-Type': 'application/json',
			},
			body: JSON.stringify({
				// BUG-12 (13/11/2026, Phase 5 production): truy vấn "tất cả script"
				// KHÔNG trả dòng `alkcloud-api` — request của Worker chạy qua route
				// bị gom vào nhóm `__unknown__` ⇒ lọc client-side theo scriptName
				// luôn ra 0 ⇒ `alkApiCallsUsed` mãi bằng 0 ⇒ cảnh báo ngân sách
				// API của riêng AlkCloud KHÔNG BAO GIỜ kích hoạt.
				// Nay lấy 2 tập: `all` (toàn account) + `alk` (lọc server-side
				// theo scriptName) trong MỘT request ⇒ vẫn 1 lần gọi API.
				query: `query($a: string!, $s: string!, $e: string!, $n: string!) {
					viewer { accounts(filter: {accountTag: $a}) {
						all: workersInvocationsAdaptive(limit: 10000, filter: {datetime_geq: $s, datetime_leq: $e}) {
							sum { requests }
							dimensions { date scriptName }
						}
						alk: workersInvocationsAdaptive(limit: 10000, filter: {datetime_geq: $s, datetime_leq: $e, scriptName: $n}) {
							sum { requests }
							dimensions { date scriptName }
						}
					} }
				}`,
				variables: {
					a: accountId,
					s: `${day}T00:00:00.000Z`,
					e: `${day}T23:59:59.999Z`,
					n: WORKER_SCRIPT_NAME,
				},
			}),
		});
		const payload = (await response.json()) as {
			errors?: Array<{ message?: string }>;
			data?: {
				viewer?: {
					accounts?: Array<{
						all?: Array<{ sum?: { requests?: number }; dimensions?: { scriptName?: string } }>;
						alk?: Array<{ sum?: { requests?: number }; dimensions?: { scriptName?: string } }>;
					}>;
				};
			};
		};
		// Fail-safe: token sai/thiếu scope ⇒ HTTP 403 hoặc `errors` trong body.
		// Nếu coi như "0 request" thì dataAvailable=true ⇒ hệ thống TƯỞNG là còn
		// dưới ngưỡng và KHÔNG bao giờ degrade ⇒ mất cơ chế bảo vệ quota.
		if (!response.ok) {
			throw new Error(`analytics HTTP ${response.status}`);
		}
		if (payload.errors && payload.errors.length > 0) {
			throw new Error('analytics GraphQL trả lỗi');
		}
		const account = payload.data?.viewer?.accounts?.[0];
		const allRows = account?.all ?? [];
		const alkRows = account?.alk ?? [];
		let accountUsed = 0;
		for (const row of allRows) {
			accountUsed += Number(row.sum?.requests ?? 0);
		}
		let alkUsed = 0;
		for (const row of alkRows) {
			alkUsed += Number(row.sum?.requests ?? 0);
		}
		return {
			accountRequestsUsed: accountUsed,
			accountRequestLimit: limit,
			alkApiCallsUsed: alkUsed,
			alkApiBudget: budget,
			dataAvailable: true,
		};
	} catch {
		return {
			accountRequestsUsed: state?.accountRequestsUsed ?? 0,
			accountRequestLimit: limit,
			alkApiCallsUsed: state?.alkApiCallsUsed ?? usage?.api_calls ?? 0,
			alkApiBudget: state?.alkApiBudget ?? budget,
			dataAvailable: false,
		};
	}
}
