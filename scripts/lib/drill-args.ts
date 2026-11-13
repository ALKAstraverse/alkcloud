/**
 * Tham số CLI cho restore drill (tách riêng để test được).
 *
 * BUG-08 (phát hiện 13/11/2026, Phase 5 production):
 *   `restore-drill.ts` **không** nhận file backup có sẵn — luôn export D1 local.
 *   ⇒ không thể drill-restore một backup production đã tải về (chỉ có thể
 *   drill trên D1 local), nên "restore thành công từ file backup production"
 *   chưa từng được chứng minh.
 *
 * Bất biến:
 *   DR1. `--file <path>` ⇒ dùng dump có sẵn (không export local).
 *   DR2. `--remote` ⇒ TỪ CHỐI (drill chỉ chạy local, không bao giờ đụng production).
 *   DR3. `--file` và `--json` có thể đi cùng nhau.
 */

export interface DrillArgs {
	/** Đường dẫn dump có sẵn — undefined = export D1 local. */
	file?: string;
	/** Đường dẫn ghi thêm báo cáo JSON. */
	json?: string;
}

export class DrillArgsError extends Error {}

export function parseDrillArgs(argv: string[]): DrillArgs {
	if (argv.includes('--remote')) {
		throw new DrillArgsError(
			'Từ chối: restore drill KHÔNG chạy trên remote (production).',
		);
	}
	const result: DrillArgs = {};
	const fileIndex = argv.indexOf('--file');
	if (fileIndex !== -1) {
		const value = argv[fileIndex + 1];
		if (!value || value.startsWith('--')) {
			throw new DrillArgsError('--file cần đường dẫn file SQL.');
		}
		result.file = value;
	}
	const jsonIndex = argv.indexOf('--json');
	if (jsonIndex !== -1) {
		const value = argv[jsonIndex + 1];
		if (!value || value.startsWith('--')) {
			throw new DrillArgsError('--json cần đường dẫn file đầu ra.');
		}
		result.json = value;
	}
	return result;
}
