import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import {
	ALERT_THRESHOLDS,
	MODE_COOLDOWN_MS,
	QUOTA_ENTER_THRESHOLDS,
	QUOTA_EXIT_THRESHOLDS,
	RELAX_CONSECUTIVE_CYCLES,
	alertLevelFor,
	capabilitiesFor,
	computeUtilization,
	evaluateQuota,
	initialQuotaState,
	modeRank,
} from '@alkcloud/core';

const ACCOUNT_LIMIT = 100_000;
const BUDGET = 20_000;

function snapshot(used: number, limit = ACCOUNT_LIMIT, budgetUsed = 0, budget = BUDGET) {
	return {
		accountRequestsUsed: used,
		accountRequestLimit: limit,
		alkApiCallsUsed: budgetUsed,
		alkApiBudget: budget,
		dataAvailable: true,
	};
}

describe('quota thresholds', () => {
	it('ngưỡng enter/exit khớp D17', () => {
		assert.deepEqual(QUOTA_ENTER_THRESHOLDS, { CONSERVE: 0.6, READ_ONLY: 0.75, EMERGENCY: 0.85 });
		assert.deepEqual(QUOTA_EXIT_THRESHOLDS, { CONSERVE: 0.5, READ_ONLY: 0.65, EMERGENCY: 0.75 });
		assert.equal(RELAX_CONSECUTIVE_CYCLES, 3);
		assert.equal(MODE_COOLDOWN_MS, 30 * 60 * 1000);
	});

	it('thứ tự mode đúng', () => {
		assert.equal(modeRank('NORMAL'), 0);
		assert.equal(modeRank('CONSERVE'), 1);
		assert.equal(modeRank('READ_ONLY'), 2);
		assert.equal(modeRank('EMERGENCY'), 3);
	});
});

describe('computeUtilization', () => {
	it('lấy max(account, budget)', () => {
		const result = computeUtilization(snapshot(10_000, ACCOUNT_LIMIT, 18_000, BUDGET));
		assert.equal(result.utilizationAccount, 0.1);
		assert.equal(result.utilizationBudget, 0.9);
		assert.equal(result.utilization, 0.9);
	});

	it('không chia cho 0', () => {
		const result = computeUtilization(snapshot(10, 0, 10, 0));
		assert.equal(result.utilization, 0);
	});
});

describe('evaluateQuota — leo thang', () => {
	it('NORMAL -> CONSERVE khi vượt 60%', () => {
		const decision = evaluateQuota(initialQuotaState(0), snapshot(61_000), 0);
		assert.equal(decision.mode, 'CONSERVE');
		assert.equal(decision.changed, true);
		assert.equal(decision.escalated, true);
		assert.equal(decision.consecutiveBelow, 0);
	});

	it('leo thang thẳng EMERGENCY khi vượt 85%', () => {
		const decision = evaluateQuota(initialQuotaState(0), snapshot(90_000), 0);
		assert.equal(decision.mode, 'EMERGENCY');
		assert.equal(decision.escalated, true);
	});

	it('dùng ngân sách AlkCloud khi account còn dư', () => {
		const decision = evaluateQuota(initialQuotaState(0), snapshot(1_000, ACCOUNT_LIMIT, 16_000, BUDGET), 0);
		assert.equal(decision.mode, 'READ_ONLY');
		assert.equal(decision.utilizationBudget, 0.8);
		assert.equal(decision.utilizationAccount, 0.01);
		assert.equal(decision.utilization, 0.8);
	});
});

describe('evaluateQuota — hạ bậc có hysteresis', () => {
	it('không hạ bậc ngay khi xuống dưới ngưỡng exit', () => {
		let state = { ...initialQuotaState(0), mode: 'CONSERVE' as const };
		const now = MODE_COOLDOWN_MS + 1;
		const first = evaluateQuota(state, snapshot(10_000), now);
		assert.equal(first.mode, 'CONSERVE');
		assert.equal(first.changed, false);
		assert.equal(first.consecutiveBelow, 1);
		state = { ...state, consecutiveBelow: first.consecutiveBelow };

		const second = evaluateQuota(state, snapshot(10_000), now);
		assert.equal(second.mode, 'CONSERVE');
		assert.equal(second.consecutiveBelow, 2);
		state = { ...state, consecutiveBelow: second.consecutiveBelow };

		const third = evaluateQuota(state, snapshot(10_000), now);
		assert.equal(third.mode, 'NORMAL');
		assert.equal(third.changed, true);
		assert.equal(third.escalated, false);
	});

	it('reset bộ đếm khi utilization vượt lại ngưỡng exit', () => {
		const state = { ...initialQuotaState(0), mode: 'CONSERVE' as const, consecutiveBelow: 2 };
		const decision = evaluateQuota(state, snapshot(60_000), MODE_COOLDOWN_MS + 1);
		assert.equal(decision.consecutiveBelow, 0);
		assert.equal(decision.mode, 'CONSERVE');
	});

	it('cooldown chặn hạ bậc dù đủ chu kỳ liên tục', () => {
		const state = { ...initialQuotaState(0), mode: 'CONSERVE' as const, consecutiveBelow: 2 };
		const decision = evaluateQuota(state, snapshot(10_000), 1000);
		assert.equal(decision.mode, 'CONSERVE');
		assert.equal(decision.cooldownActive, true);
	});

	it('chỉ hạ 1 bậc mỗi lần', () => {
		const state = { ...initialQuotaState(0), mode: 'EMERGENCY' as const, consecutiveBelow: 2 };
		const decision = evaluateQuota(state, snapshot(1_000), MODE_COOLDOWN_MS + 1);
		assert.equal(decision.mode, 'READ_ONLY');
	});
});

describe('evaluateQuota — fail-safe', () => {
	it('giữ mode hiện tại khi metrics không khả dụng', () => {
		const state = { ...initialQuotaState(0), mode: 'READ_ONLY' as const, consecutiveBelow: 1 };
		const decision = evaluateQuota(state, { ...snapshot(99_000), dataAvailable: false }, 0);
		assert.equal(decision.mode, 'READ_ONLY');
		assert.equal(decision.changed, false);
		assert.equal(decision.consecutiveBelow, 1);
		assert.match(decision.reason, /metrics_unavailable/);
	});
});

describe('capabilitiesFor — degradation matrix', () => {
	it('NORMAL cho phép tất cả', () => {
		const caps = capabilitiesFor('NORMAL');
		assert.equal(caps.allowNewUploadSession, true);
		assert.equal(caps.allowPresignMoreParts, true);
		assert.equal(caps.allowCompleteUpload, true);
		assert.equal(caps.allowNewShare, true);
		assert.equal(caps.allowMandatoryAudit, true);
		assert.equal(caps.maxConcurrentUploads, 4);
	});

	it('CONSERVE chặn upload mới? Không — chỉ chặn share/search/stats/purge', () => {
		const caps = capabilitiesFor('CONSERVE');
		assert.equal(caps.allowNewUploadSession, true);
		assert.equal(caps.allowPresignMoreParts, true);
		assert.equal(caps.allowNewShare, false);
		assert.equal(caps.allowSearch, false);
		assert.equal(caps.allowStats, false);
		assert.equal(caps.allowTrashPurge, false);
		assert.equal(caps.allowMandatoryAudit, true);
	});

	it('READ_ONLY chặn cấp part URL mới nhưng vẫn cho complete', () => {
		const caps = capabilitiesFor('READ_ONLY');
		assert.equal(caps.allowNewUploadSession, false);
		assert.equal(caps.allowPresignMoreParts, false);
		assert.equal(caps.allowCompleteUpload, true);
		assert.equal(caps.allowPublicShareDownload, true);
		assert.equal(caps.allowMandatoryAudit, true);
	});

	it('EMERGENCY chặn cả download share nhưng vẫn hoàn tất upload', () => {
		const caps = capabilitiesFor('EMERGENCY');
		assert.equal(caps.allowNewUploadSession, false);
		assert.equal(caps.allowPresignMoreParts, false);
		assert.equal(caps.allowCompleteUpload, true);
		assert.equal(caps.allowPublicShareDownload, false);
		assert.equal(caps.allowMandatoryAudit, true);
	});
});

describe('alertLevelFor', () => {
	it('phân loại đúng ngưỡng', () => {
		assert.equal(alertLevelFor(0.39), 'OK');
		assert.equal(alertLevelFor(0.6), 'WARN');
		assert.equal(alertLevelFor(0.75), 'HIGH');
		assert.equal(alertLevelFor(0.85), 'CRITICAL');
	});

	it('ngưỡng cảnh báo khớp ngưỡng degrade', () => {
		assert.deepEqual([...ALERT_THRESHOLDS], [0.4, 0.6, 0.75, 0.85]);
	});
});
