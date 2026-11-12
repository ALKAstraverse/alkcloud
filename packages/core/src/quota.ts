import type { DegradationMode, QuotaEvaluationState } from './types.js';

export const DEFAULT_DAILY_API_BUDGET = 20_000;
export const ACCOUNT_DAILY_REQUEST_LIMIT = 100_000;

/**
 * Ngưỡng vào/ra của từng mode (D17).
 * - enter: dùng để leo thang lên mode nghiêm ngặt hơn (áp dụng ngay).
 * - exit: dùng để hạ 1 bậc, cần giữ liên tục `RELAX_CONSECUTIVE_CYCLES` chu kỳ
 *         và đã qua `MODE_COOLDOWN_MS` kể từ lần đổi mode gần nhất (hysteresis).
 */
export const QUOTA_ENTER_THRESHOLDS: Record<Exclude<DegradationMode, 'NORMAL'>, number> = {
	CONSERVE: 0.6,
	READ_ONLY: 0.75,
	EMERGENCY: 0.85,
};

export const QUOTA_EXIT_THRESHOLDS: Record<Exclude<DegradationMode, 'NORMAL'>, number> = {
	CONSERVE: 0.5,
	READ_ONLY: 0.65,
	EMERGENCY: 0.75,
};

export const RELAX_CONSECUTIVE_CYCLES = 3;
export const MODE_COOLDOWN_MS = 30 * 60 * 1000;

const MODE_ORDER: DegradationMode[] = ['NORMAL', 'CONSERVE', 'READ_ONLY', 'EMERGENCY'];

export interface QuotaSnapshot {
	accountRequestsUsed: number;
	accountRequestLimit: number;
	alkApiCallsUsed: number;
	alkApiBudget: number;
	/** false khi không lấy được số liệu (GraphQL lỗi) => giữ nguyên mode, không hạ bậc. */
	dataAvailable: boolean;
}

export interface QuotaDecision {
	mode: DegradationMode;
	changed: boolean;
	escalated: boolean;
	consecutiveBelow: number;
	utilizationAccount: number;
	utilizationBudget: number;
	utilization: number;
	reason: string;
	cooldownActive: boolean;
}

export function initialQuotaState(nowMs: number): QuotaEvaluationState {
	return {
		mode: 'NORMAL',
		consecutiveBelow: 0,
		lastChangedAtMs: nowMs,
		reason: 'initial',
	};
}

export function modeRank(mode: DegradationMode): number {
	return MODE_ORDER.indexOf(mode);
}

/** Mức sử dụng dùng để quyết định = max(account, budget AlkCloud). */
export function computeUtilization(snapshot: QuotaSnapshot): {
	utilizationAccount: number;
	utilizationBudget: number;
	utilization: number;
} {
	const utilizationAccount =
		snapshot.accountRequestLimit > 0
			? snapshot.accountRequestsUsed / snapshot.accountRequestLimit
			: 0;
	const utilizationBudget =
		snapshot.alkApiBudget > 0 ? snapshot.alkApiCallsUsed / snapshot.alkApiBudget : 0;
	return {
		utilizationAccount,
		utilizationBudget,
		utilization: Math.max(utilizationAccount, utilizationBudget),
	};
}

/**
 * Đánh giá mode mới từ snapshot + state trước đó.
 * - Leo thang: tức thì khi vượt ngưỡng enter (không cần cooldown).
 * - Hạ bậc: cần giữ dưới ngưỡng exit liên tục RELAX_CONSECUTIVE_CYCLES chu kỳ
 *   VÀ đã hết cooldown kể từ lần đổi mode gần nhất. Chỉ hạ 1 bậc mỗi lần.
 * - Không có dữ liệu: giữ nguyên mode (fail-safe), không đổi consecutiveBelow.
 */
export function evaluateQuota(
	state: QuotaEvaluationState,
	snapshot: QuotaSnapshot,
	nowMs: number,
): QuotaDecision {
	const { utilizationAccount, utilizationBudget, utilization } = computeUtilization(snapshot);

	if (!snapshot.dataAvailable) {
		return {
			mode: state.mode,
			changed: false,
			escalated: false,
			consecutiveBelow: state.consecutiveBelow,
			utilizationAccount,
			utilizationBudget,
			utilization,
			reason: 'metrics_unavailable: giữ mode hiện tại',
			cooldownActive: false,
		};
	}

	const currentRank = modeRank(state.mode);
	let targetRank = 0;
	for (let i = 0; i < MODE_ORDER.length; i++) {
		const mode = MODE_ORDER[i]!;
		if (mode === 'NORMAL') continue;
		if (utilization >= QUOTA_ENTER_THRESHOLDS[mode]) targetRank = i;
	}

	if (targetRank > currentRank) {
		const mode = MODE_ORDER[targetRank]!;
		const enterThreshold = QUOTA_ENTER_THRESHOLDS[mode as Exclude<DegradationMode, 'NORMAL'>];
		return {
			mode,
			changed: true,
			escalated: true,
			consecutiveBelow: 0,
			utilizationAccount,
			utilizationBudget,
			utilization,
			reason: `vượt ngưỡng enter ${enterThreshold} (util=${utilization.toFixed(3)})`,
			cooldownActive: false,
		};
	}

	const exitThreshold =
		state.mode === 'NORMAL' ? 0 : QUOTA_EXIT_THRESHOLDS[state.mode as Exclude<DegradationMode, 'NORMAL'>];
	const consecutiveBelow = utilization < exitThreshold ? state.consecutiveBelow + 1 : 0;
	const cooldownActive = nowMs - state.lastChangedAtMs < MODE_COOLDOWN_MS;

	if (consecutiveBelow >= RELAX_CONSECUTIVE_CYCLES && !cooldownActive && currentRank > 0) {
		const mode = MODE_ORDER[currentRank - 1]!;
		return {
			mode,
			changed: true,
			escalated: false,
			consecutiveBelow: 0,
			utilizationAccount,
			utilizationBudget,
			utilization,
			reason: `hạ 1 bậc sau ${RELAX_CONSECUTIVE_CYCLES} chu kỳ dưới ngưỡng exit ${exitThreshold}`,
			cooldownActive,
		};
	}

	return {
		mode: state.mode,
		changed: false,
		escalated: false,
		consecutiveBelow,
		utilizationAccount,
		utilizationBudget,
		utilization,
		reason:
			consecutiveBelow > 0
				? `đang hồi phục (${consecutiveBelow}/${RELAX_CONSECUTIVE_CYCLES})${cooldownActive ? ', cooldown' : ''}`
				: 'giữ nguyên mode',
		cooldownActive,
	};
}

export interface ModeCapabilities {
	/** Tạo upload session mới + cấp part URL đầu tiên. */
	allowNewUploadSession: boolean;
	/** Cấp thêm part URL cho upload đang mở. */
	allowPresignMoreParts: boolean;
	/** Hoàn tất upload đang mở (luôn ưu tiên để không mất dữ liệu). */
	allowCompleteUpload: boolean;
	allowNewShare: boolean;
	allowShareUnlock: boolean;
	allowPublicShareDownload: boolean;
	/** Owner tải file của chính mình — luôn được phép (kể cả EMERGENCY). */
	allowOwnerDownload: boolean;
	allowSearch: boolean;
	allowStats: boolean;
	allowBackgroundJobs: boolean;
	allowTrashPurge: boolean;
	/** Audit bảo mật / thay đổi dữ liệu: KHÔNG BAO GIỜ bị tắt. */
	allowMandatoryAudit: boolean;
	/** Số upload đồng thời tối đa. */
	maxConcurrentUploads: number;
}

const CAPABILITIES: Record<DegradationMode, ModeCapabilities> = {
	NORMAL: {
		allowNewUploadSession: true,
		allowPresignMoreParts: true,
		allowCompleteUpload: true,
		allowNewShare: true,
		allowShareUnlock: true,
		allowPublicShareDownload: true,
		allowOwnerDownload: true,
		allowSearch: true,
		allowStats: true,
		allowBackgroundJobs: true,
		allowTrashPurge: true,
		allowMandatoryAudit: true,
		maxConcurrentUploads: 4,
	},
	CONSERVE: {
		allowNewUploadSession: true,
		allowPresignMoreParts: true,
		allowCompleteUpload: true,
		allowNewShare: false,
		allowShareUnlock: true,
		allowPublicShareDownload: true,
		allowOwnerDownload: true,
		allowSearch: false,
		allowStats: false,
		allowBackgroundJobs: false,
		allowTrashPurge: false,
		allowMandatoryAudit: true,
		maxConcurrentUploads: 2,
	},
	READ_ONLY: {
		allowNewUploadSession: false,
		allowPresignMoreParts: false,
		allowCompleteUpload: true,
		allowNewShare: false,
		allowShareUnlock: false,
		allowPublicShareDownload: true,
		allowOwnerDownload: true,
		allowSearch: false,
		allowStats: false,
		allowBackgroundJobs: false,
		allowTrashPurge: false,
		allowMandatoryAudit: true,
		maxConcurrentUploads: 0,
	},
	EMERGENCY: {
		allowNewUploadSession: false,
		allowPresignMoreParts: false,
		allowCompleteUpload: true,
		allowNewShare: false,
		allowShareUnlock: false,
		allowPublicShareDownload: false,
		allowOwnerDownload: true,
		allowSearch: false,
		allowStats: false,
		allowBackgroundJobs: false,
		allowTrashPurge: false,
		allowMandatoryAudit: true,
		maxConcurrentUploads: 0,
	},
};

export function capabilitiesFor(mode: DegradationMode): ModeCapabilities {
	return CAPABILITIES[mode];
}

/** Ngưỡng cảnh báo (40/60/75/85%) tính trên quota account 100.000 request/ngày. */
export const ALERT_THRESHOLDS = [0.4, 0.6, 0.75, 0.85] as const;

export function alertLevelFor(utilization: number): 'OK' | 'WARN' | 'HIGH' | 'CRITICAL' {
	if (utilization >= 0.85) return 'CRITICAL';
	if (utilization >= 0.75) return 'HIGH';
	if (utilization >= 0.6) return 'WARN';
	return 'OK';
}
