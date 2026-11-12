interface SaveFilePickerOptions {
	suggestedName?: string;
	types?: { description: string; accept: Record<string, string[]> }[];
}

type SaveFilePicker = (options?: SaveFilePickerOptions) => Promise<FileSystemFileHandle>;

interface WritableStreamLike {
	write(chunk: Uint8Array): Promise<void>;
	close(): Promise<void>;
}

interface FileSystemWritableLike extends WritableStreamLike {
	seek(position: number): Promise<void>;
}

interface FileSystemFileHandleLike {
	createWritable(options?: { keepExistingData?: boolean }): Promise<FileSystemWritableLike>;
}

/**
 * Tải file xuống mà không nạp toàn bộ vào RAM khi trình duyệt hỗ trợ
 * File System Access API (Chromium). Fallback sang blob cho trình duyệt khác.
 *
 * Server đã trả `content-disposition: attachment` và hỗ trợ `Range`, nên có thể
 * stream trực tiếp response.body xong file trên đĩa.
 */
export async function downloadToFile(
	response: Response,
	fileName: string,
): Promise<{ mode: 'stream' | 'blob'; bytes: number }> {
	const picker = (globalThis as { showSaveFilePicker?: SaveFilePicker }).showSaveFilePicker;
	if (picker && response.body) {
		const handle = (await picker({
			suggestedName: fileName,
			types: [{ description: 'Tệp tải xuống', accept: { 'application/octet-stream': ['*'] } }],
		})) as FileSystemFileHandleLike;
		const writable = await handle.createWritable();
		const reader = response.body.getReader();
		let bytes = 0;
		try {
			for (;;) {
				const { done, value } = await reader.read();
				if (done) break;
				if (value) {
					bytes += value.byteLength;
					await writable.write(value);
				}
			}
			await writable.close();
		} catch (error) {
			await writable.close().catch(() => undefined);
			throw error;
		}
		return { mode: 'stream', bytes };
	}

	const blob = await response.blob();
	const url = URL.createObjectURL(blob);
	const anchor = document.createElement('a');
	anchor.href = url;
	anchor.download = fileName;
	anchor.rel = 'noopener';
	document.body.appendChild(anchor);
	anchor.click();
	anchor.remove();
	setTimeout(() => URL.revokeObjectURL(url), 30_000);
	return { mode: 'blob', bytes: blob.size };
}
