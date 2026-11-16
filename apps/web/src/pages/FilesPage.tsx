import { useCallback, useEffect, useMemo, useRef, useState, type PointerEvent as ReactPointerEvent } from 'react';
import {
	ApiError,
	createFolder,
	createShare,
	deleteFile,
	deleteFolder,
	getQuota,
	getUsage,
	listFilesAll,
	listFolders,
	listTrash,
	listTrashFolders,
	logout,
	moveFile,
	moveFolder,
	openFileUrl,
	purgeFile,
	purgeFolder,
	renameFile,
	renameFolder,
	restoreFile,
	restoreFolder,
	type FileEntry,
	type FolderEntry,
} from '../lib/api.js';
import { deriveShareVerifier, randomSalt } from '../lib/kdf.js';
import { uploadFiles, uniqueFileName } from '../lib/upload.js';
import { Button, IconButton } from '../components/Button.js';
import { ContextMenu } from '../components/ContextMenu.js';
import { Icon } from '../components/Icon.js';
import { Menu, type MenuItem } from '../components/Menu.js';
import { useToast } from '../components/Toast.js';
import { EmptyState, ErrorState, InlineNotice, SkeletonRows } from '../components/States.js';
import { UploadPanel, type UploadQueueItem } from '../components/UploadPanel.js';
import {
	DeleteConfirmDialog,
	MoveDialog,
	NewFolderDialog,
	PurgeConfirmDialog,
	RenameDialog,
	ShareDialog,
	type ShareResult,
} from '../components/FileDialogs.js';
import { SettingsPage } from './SettingsPage.js';
import { fileKind } from '../lib/file-type.js';
import { formatBytes, formatRelative, formatRemaining, quotaModeLabel } from '../lib/format.js';
import { useTheme } from '../lib/theme.js';

export type WorkspaceView = 'files' | 'trash' | 'settings';

export interface FilesPageProps {
	onLogout: () => void;
	view: WorkspaceView;
	onNavigate: (view: WorkspaceView) => void;
	ownerEmail: string | null;
}

interface Target {
	type: 'file' | 'folder';
	id: string;
	name: string;
}

/** Mục dùng chung cho bộ so sánh khi sắp xếp (thư mục không có `size`/`updatedAt`). */
interface SortableItem {
	name: string;
	createdAt: string;
	updatedAt?: string | null;
	size?: number;
}

type DialogState =
	| { kind: 'none' }
	| { kind: 'new-folder' }
	| { kind: 'rename'; target: Target }
	| { kind: 'move'; target: Target }
	| { kind: 'share'; fileId: string; name: string }
	| { kind: 'delete'; targets: Target[] }
	| { kind: 'purge'; target: Target };

type SortKey = 'name' | 'modified' | 'size';
type SortDir = 'asc' | 'desc';

const LAYOUT_KEY = 'alkcloud.layout';
const SORT_KEY = 'alkcloud.sort';
const SORT_DIR_KEY = 'alkcloud.sortDir';
/** Số file upload chạy song song — giống Nextcloud (tải tuần tự rất chậm khi nhiều file). */
const MAX_PARALLEL_UPLOADS = 3;
/** Chiều mặc định của từng kiểu sắp xếp (giống Google Drive). */
const SORT_DEFAULT_DIR: Record<SortKey, SortDir> = { name: 'asc', modified: 'desc', size: 'desc' };

/** Thiết bị cảm ứng: chạm một lần vào tên để mở (như Google Drive mobile). */
function isTouchPointer() {
	return window.matchMedia('(pointer: coarse)').matches;
}

/**
 * Nhấn giữ trên touch để vào chế độ chọn (như Google Drive mobile).
 * Trả về handler cho card + `consume()` để nuốt click phát sinh sau khi nhấn giữ
 * (tránh vừa chọn vừa mở file).
 */
function useLongPress(onLongPress: () => void) {
	const timer = useRef<number | null>(null);
	const fired = useRef(false);
	const cancel = useCallback(() => {
		if (timer.current !== null) {
			window.clearTimeout(timer.current);
			timer.current = null;
		}
	}, []);
	useEffect(() => cancel, [cancel]);
	const onPointerDown = useCallback(
		(event: ReactPointerEvent<HTMLElement>) => {
			if (event.pointerType !== 'touch') return;
			if ((event.target as HTMLElement).closest('.file-card__actions')) return;
			cancel();
			fired.current = false;
			timer.current = window.setTimeout(() => {
				timer.current = null;
				fired.current = true;
				navigator.vibrate?.(10);
				onLongPress();
			}, 450);
		},
		[cancel, onLongPress],
	);
	const consume = useCallback(() => {
		const wasFired = fired.current;
		fired.current = false;
		return wasFired;
	}, []);
	return {
		onPointerDown,
		onPointerUp: cancel,
		onPointerLeave: cancel,
		onPointerCancel: cancel,
		consume,
	};
}

function readStored<T extends string>(key: string, allowed: readonly T[], fallback: T): T {
	try {
		const value = window.localStorage.getItem(key);
		if (value && (allowed as readonly string[]).includes(value)) return value as T;
	} catch {
		// ignore
	}
	return fallback;
}

function store(key: string, value: string): void {
	try {
		window.localStorage.setItem(key, value);
	} catch {
		// ignore
	}
}

function errorMessage(caught: unknown, fallback: string): string {
	return caught instanceof ApiError ? caught.message : fallback;
}


let uploadSeq = 0;

export function FilesPage({ onLogout, view, onNavigate, ownerEmail }: FilesPageProps) {
	const toast = useToast();
	const { theme, toggle: toggleTheme } = useTheme();

	const [folderId, setFolderId] = useState<string | null>(null);
	const [breadcrumb, setBreadcrumb] = useState<{ id: string; name: string }[]>([]);
	const [files, setFiles] = useState<FileEntry[]>([]);
	const [folders, setFolders] = useState<FolderEntry[]>([]);
	const [trashFiles, setTrashFiles] = useState<FileEntry[]>([]);
	const [trashFolders, setTrashFolders] = useState<FolderEntry[]>([]);
	const [mode, setMode] = useState('NORMAL');
	const [usage, setUsage] = useState<{ quotaBytes: number; usedBytes: number; reservedBytes: number } | null>(null);

	const [searchInput, setSearchInput] = useState('');
	const [query, setQuery] = useState('');
	// Mặc định dạng danh sách (bảng cột như Nextcloud) — lưới vẫn chọn được
	// qua nút chuyển dạng ở thanh công cụ.
	const [layout, setLayout] = useState<'grid' | 'list'>(() => readStored(LAYOUT_KEY, ['grid', 'list'], 'list'));
	const [sort, setSort] = useState<SortKey>(() => readStored(SORT_KEY, ['name', 'modified', 'size'], 'name'));
	const [sortDir, setSortDir] = useState<SortDir>(() => readStored(SORT_DIR_KEY, ['asc', 'desc'], 'asc'));
	const [selected, setSelected] = useState<Set<string>>(new Set());

	const [loading, setLoading] = useState(true);
	const [error, setError] = useState<string | null>(null);
	const [busy, setBusy] = useState(false);
	const [mobileNav, setMobileNav] = useState(false);
	const [dragging, setDragging] = useState(false);

	const [dialog, setDialog] = useState<DialogState>({ kind: 'none' });
	const [contextMenu, setContextMenu] = useState<{
		x: number;
		y: number;
		target: Target;
		source: HTMLElement | null;
	} | null>(null);
	const [queue, setQueue] = useState<UploadQueueItem[]>([]);
	const [queueOpen, setQueueOpen] = useState(true);

	const fileInput = useRef<HTMLInputElement>(null);
	const navButtonRef = useRef<HTMLButtonElement>(null);
	const navRef = useRef<HTMLElement>(null);
	const navWasOpen = useRef(false);
	const dragDepth = useRef(0);
	const filesRef = useRef(new Map<string, File>());
	const controllers = useRef(new Map<string, AbortController>());
	const processing = useRef(0);

	// ------------------------------------------------------------------ data
	const refresh = useCallback(
		async (options?: { silent?: boolean }) => {
			if (!options?.silent) setLoading(true);
			try {
				if (view === 'trash') {
					const [trashResult, trashFolderResult] = await Promise.all([listTrash(), listTrashFolders()]);
					setTrashFiles(trashResult.files);
					setTrashFolders(trashFolderResult.folders);
				} else {
					const [fileResult, folderResult] = await Promise.all([
						listFilesAll({ parentId: folderId, q: query || undefined }),
						listFolders(folderId),
					]);
					setFiles(fileResult.files);
					setFolders(query ? [] : folderResult.folders);
					setMode(fileResult.mode);
				}
				const [quota, usageResult] = await Promise.all([getQuota(), getUsage()]);
				setMode(quota.mode);
				setUsage(usageResult);
				setError(null);
			} catch (caught) {
				setError(errorMessage(caught, 'Không tải được dữ liệu. Kiểm tra kết nối và thử lại.'));
			} finally {
				setLoading(false);
			}
		},
		[view, folderId, query],
	);

	useEffect(() => {
		void refresh();
	}, [refresh]);

	// Debounce ô tìm kiếm.
	useEffect(() => {
		const timer = window.setTimeout(() => setQuery(searchInput.trim()), 300);
		return () => window.clearTimeout(timer);
	}, [searchInput]);

	// Đổi thư mục / đổi view ⇒ bỏ chọn (id cũ không còn ý nghĩa).
	useEffect(() => {
		setSelected(new Set());
	}, [folderId, view, query]);

	useEffect(() => {
		if (!mobileNav) return;
		const onKey = (event: KeyboardEvent) => {
			if (event.key === 'Escape') setMobileNav(false);
		};
		document.addEventListener('keydown', onKey);
		return () => document.removeEventListener('keydown', onKey);
	}, [mobileNav]);

	// Drawer mobile: mở ⇒ đưa tiêu điểm vào menu; đóng ⇒ trả tiêu điểm về nút mở.
	useEffect(() => {
		if (mobileNav) {
			navWasOpen.current = true;
			navRef.current?.querySelector<HTMLElement>('.side-nav__item')?.focus({ preventScroll: true });
			return;
		}
		if (!navWasOpen.current) return;
		navWasOpen.current = false;
		navButtonRef.current?.focus({ preventScroll: true });
	}, [mobileNav]);

	// --------------------------------------------------------------- derived
	const usagePercent = useMemo(() => {
		if (!usage || usage.quotaBytes <= 0) return 0;
		return Math.min(100, ((usage.usedBytes + usage.reservedBytes) / usage.quotaBytes) * 100);
	}, [usage]);

	/**
	 * Đổi kiểu sắp xếp: bấm cột khác ⇒ dùng chiều mặc định của cột đó;
	 * bấm lại cùng cột ⇒ đảo chiều (tăng dần / giảm dần).
	 */
	const applySort = useCallback(
		(key: SortKey) => {
			if (sort === key) {
				const next: SortDir = sortDir === 'asc' ? 'desc' : 'asc';
				setSortDir(next);
				store(SORT_DIR_KEY, next);
				return;
			}
			setSort(key);
			store(SORT_KEY, key);
			const next = SORT_DEFAULT_DIR[key];
			setSortDir(next);
			store(SORT_DIR_KEY, next);
		},
		[sort, sortDir],
	);

	const compareBy = (a: SortableItem, b: SortableItem): number => {
		let result = 0;
		if (sort === 'size') result = (a.size ?? 0) - (b.size ?? 0);
		else if (sort === 'modified') {
			result = (a.updatedAt ?? a.createdAt).localeCompare(b.updatedAt ?? b.createdAt);
		} else result = a.name.localeCompare(b.name, 'vi');
		return sortDir === 'asc' ? result : -result;
	};

	const sortedFolders = useMemo(() => {
		const list = [...folders];
		list.sort(compareBy);
		return list;
		// eslint-disable-next-line react-hooks/exhaustive-deps
	}, [folders, sort, sortDir]);

	const sortedFiles = useMemo(() => {
		const list = [...files];
		list.sort(compareBy);
		return list;
		// eslint-disable-next-line react-hooks/exhaustive-deps
	}, [files, sort, sortDir]);

	const totalItems = sortedFolders.length + sortedFiles.length;
	const trashTotal = trashFolders.length + trashFiles.length;
	const initial = (ownerEmail ?? 'A').trim().charAt(0).toUpperCase();

	const selectedTargets = useMemo<Target[]>(() => {
		const targets: Target[] = [];
		for (const key of selected) {
			const [type, id] = key.split(':') as ['file' | 'folder', string];
			const source = type === 'file' ? files : folders;
			const match = source.find((item) => item.id === id);
			if (match) targets.push({ type, id, name: match.name });
		}
		return targets;
	}, [selected, files, folders]);

	// --------------------------------------------------------------- actions
	const navigateTo = useCallback(
		(next: WorkspaceView) => {
			setMobileNav(false);
			if (next === 'files' && view !== 'files') {
				setBreadcrumb([]);
				setFolderId(null);
			}
			onNavigate(next);
		},
		[onNavigate, view],
	);

	const enterFolder = (folder: FolderEntry) => {
		setBreadcrumb((current) => [...current, { id: folder.id, name: folder.name }]);
		setFolderId(folder.id);
		setSearchInput('');
	};

	const goToCrumb = (index: number) => {
		const next = breadcrumb.slice(0, index + 1);
		setBreadcrumb(next);
		setFolderId(next.length > 0 ? next[next.length - 1]!.id : null);
	};

	const openFile = async (file: FileEntry) => {
		try {
			// Navigation tới presigned GET của B2 — file KHÔNG đi qua Worker.
			const result = await openFileUrl(file.id);
			window.location.assign(result.url);
		} catch (caught) {
			toast.push({ tone: 'error', title: 'Không mở được tệp', message: errorMessage(caught, file.name) });
		}
	};

	const toggleSelect = (type: 'file' | 'folder', id: string) => {
		const key = `${type}:${id}`;
		setSelected((current) => {
			const next = new Set(current);
			if (next.has(key)) next.delete(key);
			else next.add(key);
			return next;
		});
	};

	const allSelected = totalItems > 0 && selected.size === totalItems;

	const toggleSelectAll = () => {
		if (allSelected) {
			setSelected(new Set());
			return;
		}
		const next = new Set<string>();
		for (const folder of sortedFolders) next.add(`folder:${folder.id}`);
		for (const file of sortedFiles) next.add(`file:${file.id}`);
		setSelected(next);
	};

	// ------------------------------------------------------- context menu
	const folderActions = useCallback(
		(folder: FolderEntry): MenuItem[] => [
			{
				id: 'open',
				label: 'Mở thư mục',
				icon: 'folderOpen',
				onSelect: () => enterFolder(folder),
			},
			{
				id: 'rename',
				label: 'Đổi tên',
				icon: 'pen',
				onSelect: () => setDialog({ kind: 'rename', target: { type: 'folder', id: folder.id, name: folder.name } }),
			},
			{
				id: 'move',
				label: 'Di chuyển',
				icon: 'move',
				onSelect: () => setDialog({ kind: 'move', target: { type: 'folder', id: folder.id, name: folder.name } }),
			},
			{
				id: 'delete',
				label: 'Xoá',
				icon: 'trashCan',
				danger: true,
				onSelect: () => setDialog({ kind: 'delete', targets: [{ type: 'folder', id: folder.id, name: folder.name }] }),
			},
		],
		// eslint-disable-next-line react-hooks/exhaustive-deps
		[],
	);

	const fileActions = useCallback(
		(file: FileEntry): MenuItem[] => [
			{ id: 'download', label: 'Tải xuống', icon: 'download', onSelect: () => void openFile(file) },
			{
				id: 'share',
				label: 'Chia sẻ',
				icon: 'shareNodes',
				onSelect: () => setDialog({ kind: 'share', fileId: file.id, name: file.name }),
			},
			{
				id: 'rename',
				label: 'Đổi tên',
				icon: 'pen',
				onSelect: () => setDialog({ kind: 'rename', target: { type: 'file', id: file.id, name: file.name } }),
			},
			{
				id: 'move',
				label: 'Di chuyển',
				icon: 'move',
				onSelect: () => setDialog({ kind: 'move', target: { type: 'file', id: file.id, name: file.name } }),
			},
			{
				id: 'delete',
				label: 'Xoá',
				icon: 'trashCan',
				danger: true,
				onSelect: () => setDialog({ kind: 'delete', targets: [{ type: 'file', id: file.id, name: file.name }] }),
			},
		],
		// eslint-disable-next-line react-hooks/exhaustive-deps
		[],
	);

	const openContextMenu = (event: React.MouseEvent, target: Target) => {
		event.preventDefault();
		event.stopPropagation();
		setContextMenu({
			x: event.clientX,
			y: event.clientY,
			target,
			source: event.currentTarget as HTMLElement,
		});
	};
	const contextMenuItems = useMemo((): MenuItem[] => {
		if (!contextMenu) return [];
		const { type, id, name } = contextMenu.target;
		if (type === 'folder') {
			const folder = folders.find((item) => item.id === id);
			return folder ? folderActions(folder) : [];
		}
		const file = files.find((item) => item.id === id);
		return file ? fileActions(file) : [];
	}, [contextMenu, folders, files, folderActions, fileActions]);

	// ------------------------------------------------------------- mutations
	const runMutation = async (action: () => Promise<void>, success: string, fallback: string) => {
		setBusy(true);
		try {
			await action();
			toast.push({ tone: 'success', title: success });
			await refresh({ silent: true });
			return true;
		} catch (caught) {
			const message = errorMessage(caught, fallback);
			toast.push({ tone: 'error', title: fallback, message });
			throw new Error(message);
		} finally {
			setBusy(false);
		}
	};

	const handleCreateFolder = async (name: string) => {
		await runMutation(async () => void (await createFolder(name, folderId)), 'Đã tạo thư mục', 'Không tạo được thư mục');
	};

	const handleRename = async (target: Target, name: string) => {
		await runMutation(
			async () => {
				if (target.type === 'file') await renameFile(target.id, name);
				else await renameFolder(target.id, name);
			},
			'Đã đổi tên',
			'Không đổi được tên',
		);
	};

	const handleMove = async (target: Target, destination: string | null) => {
		await runMutation(
			async () => {
				if (target.type === 'file') await moveFile(target.id, destination);
				else await moveFolder(target.id, destination);
			},
			'Đã di chuyển',
			'Không di chuyển được',
		);
	};

	const handleDelete = async (targets: Target[]) => {
		setBusy(true);
		let failed = 0;
		for (const target of targets) {
			try {
				if (target.type === 'file') await deleteFile(target.id);
				else await deleteFolder(target.id);
			} catch {
				failed += 1;
			}
		}
		setBusy(false);
		setSelected(new Set());
		await refresh({ silent: true });
		if (failed === 0) {
			toast.push({
				tone: 'success',
				title: targets.length === 1 ? 'Đã chuyển vào thùng rác' : `Đã chuyển ${targets.length} mục vào thùng rác`,
			});
		} else {
			toast.push({
				tone: 'warning',
				title: `${failed} mục không xoá được`,
				message: 'Một số mục có thể đang được chia sẻ hoặc vừa thay đổi.',
			});
		}
	};

	const handleShare = async (fileId: string, input: { password: string | null; expiresInDays: number }): Promise<ShareResult> => {
		const passwordVerifier = input.password ? await deriveShareVerifier(input.password) : null;
		const result = await createShare({
			fileId,
			expiresInDays: input.expiresInDays,
			maxDownloads: null,
			passwordVerifier,
			passwordSalt: input.password ? randomSalt() : null,
			passwordParams: input.password ? 'sha256-v1' : null,
		});
		return { url: result.url, hasPassword: Boolean(input.password), expiresAt: result.share.expiresAt };
	};

	const handleRestore = async (target: Target) => {
		await runMutation(
			async () => {
				if (target.type === 'file') await restoreFile(target.id);
				else await restoreFolder(target.id);
			},
			'Đã khôi phục',
			'Không khôi phục được',
		);
	};

	const handlePurge = async (target: Target) => {
		await runMutation(
			async () => {
				if (target.type === 'file') await purgeFile(target.id);
				else await purgeFolder(target.id);
			},
			'Đã xoá vĩnh viễn',
			'Không xoá được',
		);
	};

	// ----------------------------------------------------------------- upload
	const enqueue = useCallback((incoming: File[]) => {
		if (incoming.length === 0) return;
		// Server từ chối trùng tên (409) sau khi đã nhận dữ liệu ⇒ tự chọn tên
		// không trùng ngay từ đầu, giống Nextcloud (`bug.txt` → `bug (1).txt`).
		const taken = [...files.map((item) => item.name), ...queue.map((item) => item.name)];
		const renamed: string[] = [];
		const items: UploadQueueItem[] = incoming.map((file) => {
			const id = `up_${Date.now().toString(36)}_${(uploadSeq += 1)}`;
			filesRef.current.set(id, file);
			const name = uniqueFileName(file.name, taken);
			taken.push(name);
			if (name !== file.name) renamed.push(name);
			return { id, name, size: file.size, uploadedBytes: 0, status: 'queued' };
		});
		setQueue((current) => [...current, ...items]);
		setQueueOpen(true);
		if (renamed.length > 0) {
			toast.push({
				tone: 'info',
				title: 'Đã đổi tên để không trùng',
				message: renamed.join(', '),
			});
		}
	}, [files, queue, toast]);

	// Xử lý hàng đợi: tối đa MAX_PARALLEL_UPLOADS file chạy song song
	// (Nextcloud cũng tải song song — tải tuần tự khiến 10 file phải chờ 10×).
	useEffect(() => {
		if (processing.current >= MAX_PARALLEL_UPLOADS) return;
		const next = queue.find((item) => item.status === 'queued' && !controllers.current.has(item.id));
		if (!next) return;
		const file = filesRef.current.get(next.id);
		if (!file) return;
		processing.current += 1;
		const controller = new AbortController();
		controllers.current.set(next.id, controller);
		setQueue((current) =>
			current.map((item) =>
				item.id === next.id ? { ...item, status: 'uploading', startedAt: Date.now() } : item,
			),
		);
		void uploadFiles([file], {
			folderId,
			name: next.name,
			signal: controller.signal,
			onProgress: (progress) => {
				setQueue((current) =>
					current.map((item) => (item.id === next.id ? { ...item, uploadedBytes: progress.uploadedBytes } : item)),
				);
			},
		})
			.then(async (result) => {
				const failedItem = result.results[0];
				if (failedItem?.status === 'success') {
					setQueue((current) =>
						current.map((item) =>
							item.id === next.id
								? { ...item, status: 'success', uploadedBytes: file.size, finishedAt: Date.now() }
								: item,
						),
					);
					filesRef.current.delete(next.id);
					await refresh({ silent: true });
				} else {
					const canceled = controller.signal.aborted;
					setQueue((current) =>
						current.map((item) =>
							item.id === next.id
								? {
										...item,
										status: canceled ? 'canceled' : 'error',
										error: canceled ? undefined : failedItem?.error ?? 'Tải lên thất bại',
									}
								: item,
						),
					);
				}
			})
			.finally(() => {
				controllers.current.delete(next.id);
				processing.current -= 1;
				// Kích hoạt vòng lặp cho file kế tiếp.
				setQueue((current) => [...current]);
			});
	}, [queue, folderId, refresh]);

	const cancelUpload = (id: string) => {
		const controller = controllers.current.get(id);
		if (controller) controller.abort();
		else {
			setQueue((current) =>
				current.map((item) => (item.id === id && item.status === 'queued' ? { ...item, status: 'canceled' } : item)),
			);
		}
	};

	const retryUpload = (id: string) => {
		setQueue((current) =>
			current.map((item) =>
				item.id === id ? { ...item, status: 'queued', uploadedBytes: 0, error: undefined, startedAt: undefined } : item,
			),
		);
	};

	const dismissUpload = (id: string) => {
		filesRef.current.delete(id);
		setQueue((current) => current.filter((item) => item.id !== id));
	};

	const clearFinished = () => {
		setQueue((current) =>
			current.filter((item) => item.status !== 'success' && item.status !== 'error' && item.status !== 'canceled'),
		);
	};

	// -------------------------------------------------------------- drag&drop
	const onDragEnter = (event: React.DragEvent) => {
		if (view !== 'files' || !event.dataTransfer.types.includes('Files')) return;
		dragDepth.current += 1;
		setDragging(true);
	};
	const onDragLeave = () => {
		dragDepth.current = Math.max(0, dragDepth.current - 1);
		if (dragDepth.current === 0) setDragging(false);
	};
	const onDrop = (event: React.DragEvent) => {
		event.preventDefault();
		dragDepth.current = 0;
		setDragging(false);
		if (view !== 'files') return;
		const dropped = Array.from(event.dataTransfer.files);
		if (dropped.length > 0) enqueue(dropped);
	};

	// ------------------------------------------------------------------ render
	const title = view === 'trash' ? 'Thùng rác' : view === 'settings' ? 'Cài đặt' : 'Tệp của tôi';
	const subtitle =
		view === 'trash'
			? 'Mục đã xoá được giữ 30 ngày trước khi bị xoá vĩnh viễn.'
			: view === 'settings'
				? 'Tài khoản, bảo mật và giao diện.'
				: query
					? `Kết quả cho “${query}”`
					: breadcrumb.length > 0
						? breadcrumb[breadcrumb.length - 1]!.name
						: 'Toàn bộ tệp và thư mục trên AlkCloud';

	return (
		<div className="shell">
			<a className="skip-link" href="#main-content">
				Bỏ qua tới nội dung chính
			</a>
			<button
				type="button"
				className="shell__scrim"
				aria-label="Đóng menu điều hướng"
				hidden={!mobileNav}
				onClick={() => setMobileNav(false)}
			/>
			<aside ref={navRef} className="shell__sidebar" data-open={mobileNav ? 'true' : 'false'}>
				<div className="brand">
					<span className="brand__mark">
						<Icon name="cloud" />
					</span>
					<span style={{ minWidth: 0 }}>
						<span className="brand__name">AlkCloud</span>
						<span className="brand__tagline" style={{ display: 'block' }}>
							Lưu trữ cá nhân
						</span>
					</span>
				</div>

				<nav id="app-navigation" className="side-nav" aria-label="Điều hướng chính">
					<button
						type="button"
						className="side-nav__item"
						aria-current={view === 'files' ? 'page' : undefined}
						onClick={() => navigateTo('files')}
					>
						<Icon name="folder" />
						Tệp của tôi
					</button>
					<button
						type="button"
						className="side-nav__item"
						aria-current={view === 'trash' ? 'page' : undefined}
						onClick={() => navigateTo('trash')}
					>
						<Icon name="trashCan" />
						Thùng rác
						{trashTotal > 0 ? <span className="side-nav__count">{trashTotal}</span> : null}
					</button>
					<button
						type="button"
						className="side-nav__item"
						aria-current={view === 'settings' ? 'page' : undefined}
						onClick={() => navigateTo('settings')}
					>
						<Icon name="gear" />
						Cài đặt
					</button>
				</nav>

				<div className="side-card">
					<div className="side-card__head">
						<span className="side-card__title">
							<Icon name="hardDrive" />
							Dung lượng
						</span>
						<span className="side-card__value">{Math.round(usagePercent)}%</span>
					</div>
					<div className="progress">
						<div
							className={`progress__bar${usagePercent > 90 ? ' progress--danger' : usagePercent > 75 ? ' progress--warning' : ''}`}
							style={{ width: `${usagePercent}%` }}
						/>
					</div>
					<p className="side-card__value" style={{ marginTop: 'var(--space-3)' }}>
						{usage ? `${formatBytes(usage.usedBytes)} / ${formatBytes(usage.quotaBytes)}` : 'Đang tính…'}
						{usage && usage.reservedBytes > 0 ? ` · giữ chỗ ${formatBytes(usage.reservedBytes)}` : ''}
					</p>
				</div>

				<div className="side-card" style={{ display: 'flex', alignItems: 'center', gap: 'var(--space-4)' }}>
					<span className="avatar">{initial}</span>
					<span style={{ minWidth: 0, flex: 1 }}>
						<span className="side-card__value" style={{ display: 'block', color: 'var(--text)' }}>
							{ownerEmail ?? 'Chủ tài khoản'}
						</span>
						<span className="side-card__value" style={{ display: 'block' }}>
							{mode === 'NORMAL' ? 'Quota bình thường' : `Chế độ ${quotaModeLabel(mode)}`}
						</span>
					</span>
					<IconButton
						icon="signOut"
						label="Đăng xuất"
						size="sm"
						onClick={() => void logout().then(onLogout)}
					/>
				</div>
			</aside>

			<div className="shell__main">
				<header className="topbar">
					<IconButton
						ref={navButtonRef}
						icon="bars"
						label="Mở menu điều hướng"
						className="topbar__menu"
						aria-expanded={mobileNav}
						aria-controls="app-navigation"
						onClick={() => setMobileNav(true)}
					/>
					<div className="topbar__context">
						<h1 className="topbar__title truncate">{title}</h1>
						<span className="topbar__subtitle truncate">{subtitle}</span>
					</div>
					<div className="topbar__actions">
						<IconButton
							icon={theme === 'dark' ? 'sun' : 'moon'}
							label={theme === 'dark' ? 'Chuyển sang nền sáng' : 'Chuyển sang nền tối'}
							onClick={toggleTheme}
						/>
						<span className="topbar__divider" />
						<Menu
							label="Tài khoản"
							trigger={({ toggle }) => (
								<button type="button" className="btn btn--ghost btn--sm" onClick={toggle} aria-label="Mở menu tài khoản">
									<span className="avatar">{initial}</span>
								</button>
							)}
							items={[
								{ id: 'settings', label: 'Cài đặt', icon: 'gear', onSelect: () => navigateTo('settings') },
								{
									id: 'logout',
									label: 'Đăng xuất',
									icon: 'signOut',
									danger: true,
									onSelect: () => void logout().then(onLogout),
								},
							]}
						/>
					</div>
				</header>

				<main
					id="main-content"
					tabIndex={-1}
					className="shell__content"
					onDragEnter={onDragEnter}
					onDragOver={(event) => {
						if (view === 'files' && event.dataTransfer.types.includes('Files')) event.preventDefault();
					}}
					onDragLeave={onDragLeave}
					onDrop={onDrop}
				>
					{view === 'settings' ? (
						<SettingsPage ownerEmail={ownerEmail} usage={usage} mode={mode} onRefresh={() => void refresh({ silent: true })} />
					) : (
						<div className="manager">
							{mode !== 'NORMAL' ? (
								<InlineNotice tone="warning" title={`Chế độ ${quotaModeLabel(mode)}`}>
									Hệ thống đang hạn chế một số thao tác để bảo vệ dung lượng. Tải lên có thể bị tạm dừng.
								</InlineNotice>
							) : null}

							{view === 'files' ? (
								<>
									<div className="toolbar">
										<div className="toolbar__group">
											<Button icon="folderPlus" onClick={() => setDialog({ kind: 'new-folder' })}>
												Thư mục mới
											</Button>
											<Button
												variant="primary"
												icon="cloudArrowUp"
												onClick={() => fileInput.current?.click()}
											>
												Tải lên
											</Button>
											<span className="toolbar__count">
												{sortedFolders.length} thư mục · {sortedFiles.length} tệp
											</span>
											<input
												ref={fileInput}
												type="file"
												multiple
												hidden
												aria-label="Chọn tệp để tải lên"
												onChange={(event) => {
													const list = event.target.files;
													if (list) enqueue(Array.from(list));
													event.target.value = '';
												}}
											/>
										</div>
										<div className="toolbar__spacer" />
										<label className="search">
											<Icon name="magnifyingGlass" className="search__icon" />
											<input
												type="search"
												className="input"
												placeholder="Tìm theo tên tệp…"
												value={searchInput}
												aria-label="Tìm kiếm tệp"
												onChange={(event) => setSearchInput(event.target.value)}
											/>
										</label>
										<div className="toolbar__group toolbar__group--secondary">
											{totalItems > 0 ? (
												<Button
													size="sm"
													icon="check"
													onClick={toggleSelectAll}
													title={allSelected ? 'Bỏ chọn tất cả' : 'Chọn tất cả'}
												>
													{allSelected ? 'Bỏ chọn tất cả' : 'Chọn tất cả'}
												</Button>
											) : null}
											<div className="segmented" role="group" aria-label="Kiểu hiển thị">
												<button
													type="button"
													className="segmented__option"
													aria-pressed={layout === 'grid'}
													aria-label="Dạng lưới"
													title="Dạng lưới"
													onClick={() => {
														setLayout('grid');
														store(LAYOUT_KEY, 'grid');
													}}
												>
													<Icon name="grip" />
												</button>
												<button
													type="button"
													className="segmented__option"
													aria-pressed={layout === 'list'}
													aria-label="Dạng danh sách"
													title="Dạng danh sách"
													onClick={() => {
														setLayout('list');
														store(LAYOUT_KEY, 'list');
													}}
												>
													<Icon name="list" />
												</button>
											</div>
										<Menu
											label="Sắp xếp"
											trigger={({ toggle }) => (
												<button
													type="button"
													className="btn btn--secondary btn--sm"
													onClick={toggle}
													aria-label="Sắp xếp"
												>
													<Icon name="sort" />
													{sort === 'name' ? 'Tên' : sort === 'modified' ? 'Mới sửa' : 'Kích thước'}
													<Icon name={sortDir === 'asc' ? 'chevronUp' : 'chevronDown'} />
												</button>
											)}
											items={[
												{
													id: 'name',
													label: 'Theo tên',
													icon: 'list',
													checked: sort === 'name',
													onSelect: () => applySort('name'),
												},
												{
													id: 'modified',
													label: 'Mới sửa gần đây',
													icon: 'clock',
													checked: sort === 'modified',
													onSelect: () => applySort('modified'),
												},
												{
													id: 'size',
													label: 'Kích thước',
													icon: 'hardDrive',
													checked: sort === 'size',
													onSelect: () => applySort('size'),
												},
												{ id: 'divider', label: '', divider: true, onSelect: () => {} },
												{
													id: 'asc',
													label: 'Tăng dần',
													icon: 'chevronUp',
													checked: sortDir === 'asc',
													onSelect: () => {
														setSortDir('asc');
														store(SORT_DIR_KEY, 'asc');
													},
												},
												{
													id: 'desc',
													label: 'Giảm dần',
													icon: 'chevronDown',
													checked: sortDir === 'desc',
													onSelect: () => {
														setSortDir('desc');
														store(SORT_DIR_KEY, 'desc');
													},
												},
											]}
										/>
											<IconButton
												icon="arrowRotateRight"
												label="Tải lại danh sách"
												onClick={() => void refresh()}
											/>
										</div>
									</div>

									{breadcrumb.length > 0 && !query ? (
										<nav className="breadcrumb" aria-label="Đường dẫn thư mục">
											<button type="button" className="breadcrumb__item" onClick={() => goToCrumb(-1)}>
												<Icon name="house" />
												Thư viện
											</button>
											{breadcrumb.map((node, index) => (
												<span key={node.id} style={{ display: 'contents' }}>
													<span className="breadcrumb__separator" aria-hidden="true">
														<Icon name="chevronRight" />
													</span>
													<button type="button" className="breadcrumb__item" onClick={() => goToCrumb(index)}>
														{node.name}
													</button>
												</span>
											))}
										</nav>
									) : null}

									{loading ? (
										<SkeletonRows rows={6} />
									) : error ? (
										<ErrorState description={error} onRetry={() => void refresh()} />
									) : totalItems === 0 ? (
										query ? (
											<EmptyState
												icon="magnifyingGlass"
												title="Không tìm thấy tệp phù hợp"
												description={`Không có tệp nào khớp với “${query}”. Thử từ khoá khác hoặc xoá bộ lọc.`}
												action={{ label: 'Xoá tìm kiếm', onClick: () => setSearchInput(''), icon: 'xmark' }}
											/>
										) : (
											<EmptyState
												title="Thư mục còn trống"
												description="Kéo thả tệp vào đây hoặc bấm Tải lên để bắt đầu. Bạn cũng có thể tạo thư mục để sắp xếp."
												action={{ label: 'Tải tệp lên', onClick: () => fileInput.current?.click(), icon: 'cloudArrowUp' }}
												secondaryAction={{ label: 'Tạo thư mục', onClick: () => setDialog({ kind: 'new-folder' }), icon: 'folderPlus' }}
											/>
										)
									) : layout === 'grid' ? (
										<>
											{sortedFolders.length > 0 ? (
												<section>
													<div className="manager__section-head">
														<span className="manager__section-title">Thư mục</span>
														<span className="manager__section-count">{sortedFolders.length}</span>
													</div>
													<div className="file-grid">
														{sortedFolders.map((folder) => (
															<FolderCard
																key={folder.id}
																folder={folder}
																selected={selected.has(`folder:${folder.id}`)}
																onOpen={() => enterFolder(folder)}
																onToggle={() => toggleSelect('folder', folder.id)}
																menuItems={[
																	{
																		id: 'rename',
																		label: 'Đổi tên',
																		icon: 'pen',
																		onSelect: () =>
																			setDialog({ kind: 'rename', target: { type: 'folder', id: folder.id, name: folder.name } }),
																	},
																	{
																		id: 'move',
																		label: 'Di chuyển',
																		icon: 'move',
																		onSelect: () =>
																			setDialog({ kind: 'move', target: { type: 'folder', id: folder.id, name: folder.name } }),
																	},
																	{
																		id: 'delete',
																		label: 'Xoá',
																		icon: 'trashCan',
																		danger: true,
																		onSelect: () =>
																			setDialog({ kind: 'delete', targets: [{ type: 'folder', id: folder.id, name: folder.name }] }),
																	},
																]}
															/>
														))}
													</div>
												</section>
											) : null}

											{sortedFiles.length > 0 ? (
												<section>
													<div className="manager__section-head">
														<span className="manager__section-title">Tệp</span>
														<span className="manager__section-count">{sortedFiles.length}</span>
													</div>
													<div className="file-grid">
														{sortedFiles.map((file) => (
															<FileCard
																key={file.id}
																file={file}
																selected={selected.has(`file:${file.id}`)}
																onOpen={() => void openFile(file)}
																onToggle={() => toggleSelect('file', file.id)}
																menuItems={[
																	{ id: 'download', label: 'Tải xuống', icon: 'download', onSelect: () => void openFile(file) },
																	{
																		id: 'share',
																		label: 'Chia sẻ',
																		icon: 'shareNodes',
																		onSelect: () => setDialog({ kind: 'share', fileId: file.id, name: file.name }),
																	},
																	{
																		id: 'rename',
																		label: 'Đổi tên',
																		icon: 'pen',
																		onSelect: () =>
																			setDialog({ kind: 'rename', target: { type: 'file', id: file.id, name: file.name } }),
																	},
																	{
																		id: 'move',
																		label: 'Di chuyển',
																		icon: 'move',
																		onSelect: () =>
																			setDialog({ kind: 'move', target: { type: 'file', id: file.id, name: file.name } }),
																	},
																	{
																		id: 'delete',
																		label: 'Xoá',
																		icon: 'trashCan',
																		danger: true,
																		onSelect: () =>
																			setDialog({ kind: 'delete', targets: [{ type: 'file', id: file.id, name: file.name }] }),
																	},
																]}
															/>
														))}
													</div>
												</section>
											) : null}
										</>
									) : (
									<div className="drive" role="table" aria-label="Tệp và thư mục">
										<div className="drive__head" role="row">
											<span
												role="columnheader"
												className="drive__th"
												aria-sort={sort === 'name' ? (sortDir === 'asc' ? 'ascending' : 'descending') : 'none'}
											>
												<button
													type="button"
													className="drive__sort"
													data-active={sort === 'name'}
													onClick={() => applySort('name')}
												>
													<span>Tên</span>
													{sort === 'name' ? (
														<Icon name={sortDir === 'asc' ? 'chevronUp' : 'chevronDown'} className="drive__sort-icon" />
													) : null}
												</button>
											</span>
											<span
												role="columnheader"
												className="drive__th"
												aria-sort={sort === 'modified' ? (sortDir === 'asc' ? 'ascending' : 'descending') : 'none'}
											>
												<button
													type="button"
													className="drive__sort"
													data-active={sort === 'modified'}
													onClick={() => applySort('modified')}
												>
													<span>Sửa đổi</span>
													{sort === 'modified' ? (
														<Icon name={sortDir === 'asc' ? 'chevronUp' : 'chevronDown'} className="drive__sort-icon" />
													) : null}
												</button>
											</span>
											<span
												role="columnheader"
												className="drive__th"
												aria-sort={sort === 'size' ? (sortDir === 'asc' ? 'ascending' : 'descending') : 'none'}
											>
												<button
													type="button"
													className="drive__sort drive__sort--right"
													data-active={sort === 'size'}
													onClick={() => applySort('size')}
												>
													<span>Kích thước</span>
													{sort === 'size' ? (
														<Icon name={sortDir === 'asc' ? 'chevronUp' : 'chevronDown'} className="drive__sort-icon" />
													) : null}
												</button>
											</span>
											<span role="columnheader" className="drive__th drive__th--tail" />
										</div>
										{sortedFolders.map((folder) => (
												<div
													key={folder.id}
													className="drive__row"
													role="row"
													tabIndex={0}
													data-selected={selected.has(`folder:${folder.id}`)}
													onClick={(event) => {
														const onName = (event.target as HTMLElement).closest('.drive__name');
														if (onName && isTouchPointer() && event.detail === 1) {
															event.stopPropagation();
															enterFolder(folder);
															return;
														}
														toggleSelect('folder', folder.id);
													}}
													onDoubleClick={(event) => {
														event.stopPropagation();
														if (isTouchPointer()) return;
														enterFolder(folder);
													}}
													onKeyDown={(event) => {
														if (event.key === 'Enter') {
															event.preventDefault();
															enterFolder(folder);
														}
													}}
													onContextMenu={(event) =>
														openContextMenu(event, { type: 'folder', id: folder.id, name: folder.name })
													}
												>
													<span role="cell" className="drive__name" title="Bấm để chọn · bấm đúp để mở">
														<span className="drive__icon tone-folder">
															<Icon name="folder" />
														</span>
														<span className="drive__text">
															<span className="drive__title truncate">{folder.name}</span>
															<span className="drive__subtitle truncate">Thư mục</span>
															<span className="drive__mobile-meta truncate">
																Thư mục · {formatRelative(folder.createdAt)}
															</span>
														</span>
													</span>
													<span role="cell" className="drive__cell drive__cell--modified">{formatRelative(folder.createdAt)}</span>
													<span role="cell" className="drive__cell drive__cell--size">—</span>
													<div role="cell" className="drive__actions" onClick={(event) => event.stopPropagation()}>
														<Menu
															label={`Thao tác cho ${folder.name}`}
															trigger={({ toggle }) => (
																<IconButton icon="ellipsis" label="Thao tác" size="sm" onClick={toggle} />
															)}
															items={folderActions(folder)}
														/>
													</div>
												</div>
											))}
											{sortedFiles.map((file) => {
												const kind = fileKind(file.name, file.contentType);
												return (
													<div
														key={file.id}
														className="drive__row"
														role="row"
														tabIndex={0}
														data-selected={selected.has(`file:${file.id}`)}
														onClick={(event) => {
															const onName = (event.target as HTMLElement).closest('.drive__name');
															if (onName && isTouchPointer() && event.detail === 1) {
																event.stopPropagation();
																void openFile(file);
																return;
															}
															toggleSelect('file', file.id);
														}}
														onDoubleClick={(event) => {
															event.stopPropagation();
															if (isTouchPointer()) return;
															void openFile(file);
														}}
														onKeyDown={(event) => {
															if (event.key === 'Enter') {
																event.preventDefault();
																void openFile(file);
															}
														}}
														onContextMenu={(event) =>
															openContextMenu(event, { type: 'file', id: file.id, name: file.name })
														}
													>
														<span role="cell" className="drive__name" title="Bấm để chọn · bấm đúp để mở">
															<span className={`drive__icon ${kind.tone}`}>
																<Icon name={kind.icon} />
															</span>
															<span className="drive__text">
																<span className="drive__title truncate">{file.name}</span>
																<span className="drive__subtitle truncate">{kind.label}</span>
																<span className="drive__mobile-meta truncate">
																	{kind.label} · {formatBytes(file.size)} · {formatRelative(file.updatedAt)}
																</span>
															</span>
														</span>
														<span role="cell" className="drive__cell drive__cell--modified">{formatRelative(file.updatedAt)}</span>
														<span role="cell" className="drive__cell drive__cell--size">{formatBytes(file.size)}</span>
														<div role="cell" className="drive__actions" onClick={(event) => event.stopPropagation()}>
															<Menu
																label={`Thao tác cho ${file.name}`}
																trigger={({ toggle }) => (
																	<IconButton icon="ellipsis" label="Thao tác" size="sm" onClick={toggle} />
																)}
																items={fileActions(file)}
															/>
														</div>
													</div>
												);
											})}
										</div>
									)}

									{selected.size > 0 ? (
										<div className="bulk-bar" role="region" aria-label="Thao tác hàng loạt">
											<span className="bulk-bar__count">{selected.size} mục đã chọn</span>
											<Button size="sm" icon="move" onClick={() => setDialog({ kind: 'move', target: selectedTargets[0]! })} disabled={selectedTargets.length !== 1}>
												Di chuyển
											</Button>
											<Button
												size="sm"
												variant="danger-ghost"
												icon="trashCan"
												onClick={() => setDialog({ kind: 'delete', targets: selectedTargets })}
											>
												Xoá
											</Button>
											<IconButton icon="xmark" label="Bỏ chọn" size="sm" onClick={() => setSelected(new Set())} />
										</div>
									) : null}
								</>
							) : (
								<>
									<div className="toolbar">
										<div className="toolbar__group">
											<Button icon="arrowRotateRight" onClick={() => void refresh()}>
												Tải lại
											</Button>
										</div>
										<div className="toolbar__spacer" />
										<span className="small muted">Tự xoá vĩnh viễn sau 30 ngày</span>
									</div>

									{loading ? (
										<SkeletonRows rows={5} />
									) : error ? (
										<ErrorState description={error} onRetry={() => void refresh()} />
									) : trashTotal === 0 ? (
										<EmptyState
											icon="trashCan"
											title="Thùng rác trống"
											description="Tệp và thư mục bạn xoá sẽ nằm ở đây; tự động xoá vĩnh viễn sau 30 ngày hoặc xoá ngay bằng nút Xoá vĩnh viễn."
											action={{ label: 'Về tệp của tôi', onClick: () => navigateTo('files'), icon: 'folder' }}
										/>
									) : (
										<div className="file-list">
											{trashFolders.length > 0 ? (
												<div className="manager__section-head" style={{ padding: 'var(--space-4) var(--space-5) 0' }}>
													<span className="manager__section-title">Thư mục</span>
													<span className="manager__section-count">{trashFolders.length}</span>
												</div>
											) : null}
											{trashFolders.map((folder) => (
												<div key={folder.id} className="file-list__row file-list__row--trash">
													<span className="file-list__icon tone-folder">
														<Icon name="folder" />
													</span>
													<span className="file-list__text">
														<span className="file-list__title truncate">{folder.name}</span>
														<span className="file-list__meta">
															Đã xoá {formatRelative(folder.deletedAt)} · ẩn cùng toàn bộ nội dung
														</span>
													</span>
													<div className="file-list__actions" style={{ opacity: 1 }}>
														<Button
															size="sm"
															icon="arrowRotateRight"
															onClick={() => void handleRestore({ type: 'folder', id: folder.id, name: folder.name }).catch(() => {})}
															disabled={busy}
														>
															Khôi phục
														</Button>
														<Button
															size="sm"
															variant="danger-ghost"
															icon="broom"
															onClick={() => setDialog({ kind: 'purge', target: { type: 'folder', id: folder.id, name: folder.name } })}
														>
															Xoá vĩnh viễn
														</Button>
													</div>
												</div>
											))}
											{trashFiles.length > 0 ? (
												<div className="manager__section-head" style={{ padding: 'var(--space-4) var(--space-5) 0' }}>
													<span className="manager__section-title">Tệp</span>
													<span className="manager__section-count">{trashFiles.length}</span>
												</div>
											) : null}
											{trashFiles.map((file) => {
												const kind = fileKind(file.name, file.contentType);
												return (
													<div key={file.id} className="file-list__row file-list__row--trash">
														<span className={`file-list__icon ${kind.tone}`}>
															<Icon name={kind.icon} />
														</span>
														<span className="file-list__text">
															<span className="file-list__title truncate">{file.name}</span>
															<span className="file-list__meta">
																{formatBytes(file.size)} · xoá {formatRelative(file.deletedAt)}
															</span>
														</span>
														<span className="file-list__meta">
															{formatRemaining(file.purgeAfter)}
														</span>
														<div className="file-list__actions" style={{ opacity: 1 }}>
															<Button
																size="sm"
																icon="arrowRotateRight"
																onClick={() => void handleRestore({ type: 'file', id: file.id, name: file.name }).catch(() => {})}
																disabled={busy}
															>
																Khôi phục
															</Button>
															<Button
																size="sm"
																variant="danger-ghost"
																icon="broom"
																onClick={() => setDialog({ kind: 'purge', target: { type: 'file', id: file.id, name: file.name } })}
															>
																Xoá vĩnh viễn
															</Button>
														</div>
													</div>
												);
											})}
										</div>
									)}
								</>
							)}
						</div>
					)}

					{dragging ? (
						<div className="dropzone">
							<div className="dropzone__card">
								<span className="dropzone__icon">
									<Icon name="cloudArrowUp" />
								</span>
								<span className="dropzone__title">Thả tệp để tải lên</span>
								<span className="dropzone__hint">
									Tệp sẽ được tải vào {breadcrumb.length > 0 ? `“${breadcrumb[breadcrumb.length - 1]!.name}”` : 'thư viện'}
								</span>
							</div>
						</div>
					) : null}
				</main>
			</div>

			{queueOpen ? (
				<UploadPanel
					items={queue}
					onCancel={cancelUpload}
					onRetry={retryUpload}
					onDismiss={dismissUpload}
					onClearFinished={clearFinished}
					onClose={() => setQueueOpen(false)}
				/>
			) : queue.some((item) => item.status === 'uploading') ? (
				<button
					type="button"
					className="btn btn--primary"
					style={{ position: 'fixed', right: 'var(--space-7)', bottom: 'var(--space-7)', zIndex: 'var(--z-toast)' as unknown as number }}
					onClick={() => setQueueOpen(true)}
				>
					<Icon name="cloudArrowUp" />
					Đang tải lên…
				</button>
			) : null}

			{contextMenu && contextMenuItems.length > 0 ? (
				<ContextMenu
					x={contextMenu.x}
					y={contextMenu.y}
					label={`Thao tác cho ${contextMenu.target.name}`}
					items={contextMenuItems}
					returnFocus={contextMenu.source}
					onClose={() => setContextMenu(null)}
				/>
			) : null}

			<NewFolderDialog
				open={dialog.kind === 'new-folder'}
				onClose={() => setDialog({ kind: 'none' })}
				onSubmit={handleCreateFolder}
			/>
			<RenameDialog
				open={dialog.kind === 'rename'}
				currentName={dialog.kind === 'rename' ? dialog.target.name : ''}
				onClose={() => setDialog({ kind: 'none' })}
				onSubmit={(name) => (dialog.kind === 'rename' ? handleRename(dialog.target, name) : Promise.resolve())}
			/>
			<MoveDialog
				open={dialog.kind === 'move'}
				folders={sortedFolders.filter(
					(folder) => !(dialog.kind === 'move' && dialog.target.type === 'folder' && folder.id === dialog.target.id),
				)}
				ancestors={breadcrumb.slice(0, -1)}
				onClose={() => setDialog({ kind: 'none' })}
				onSubmit={(destination) => (dialog.kind === 'move' ? handleMove(dialog.target, destination) : Promise.resolve())}
			/>
			<ShareDialog
				open={dialog.kind === 'share'}
				onClose={() => setDialog({ kind: 'none' })}
				onSubmit={async (input) => {
					if (dialog.kind !== 'share') throw new Error('Hộp thoại đã đóng');
					return handleShare(dialog.fileId, input);
				}}
			/>
			<DeleteConfirmDialog
				open={dialog.kind === 'delete'}
				names={dialog.kind === 'delete' ? dialog.targets.map((target) => target.name) : []}
				onClose={() => setDialog({ kind: 'none' })}
				onConfirm={async () => {
					if (dialog.kind !== 'delete') return;
					await handleDelete(dialog.targets);
				}}
			/>
			<PurgeConfirmDialog
				open={dialog.kind === 'purge'}
				name={dialog.kind === 'purge' ? dialog.target.name : ''}
				onClose={() => setDialog({ kind: 'none' })}
				onConfirm={async () => {
					if (dialog.kind !== 'purge') return;
					await handlePurge(dialog.target);
				}}
			/>
		</div>
	);
}

/* ------------------------------------------------------------------ cards */
function FolderCard({
	folder,
	selected,
	onOpen,
	onToggle,
	menuItems,
}: {
	folder: FolderEntry;
	selected: boolean;
	onOpen: () => void;
	onToggle: () => void;
	menuItems: React.ComponentProps<typeof Menu>['items'];
}) {
	const longPress = useLongPress(onToggle);
	return (
		<article
			className="file-card"
			data-selected={selected}
			tabIndex={0}
			onPointerDown={longPress.onPointerDown}
			onPointerUp={longPress.onPointerUp}
			onPointerLeave={longPress.onPointerLeave}
			onPointerCancel={longPress.onPointerCancel}
			onClick={(event) => {
				if (longPress.consume()) {
					event.preventDefault();
					return;
				}
				const onBody = (event.target as HTMLElement).closest('.file-card__open');
				if (onBody && isTouchPointer() && event.detail === 1) {
					event.stopPropagation();
					onOpen();
					return;
				}
				onToggle();
			}}
			onDoubleClick={(event) => {
				event.stopPropagation();
				if (isTouchPointer()) return;
				onOpen();
			}}
			onKeyDown={(event) => {
				if (event.key === 'Enter') {
					event.preventDefault();
					onOpen();
				}
			}}
			title="Bấm để chọn · bấm đúp để mở"
		>
			<div className="file-card__actions" onClick={(event) => event.stopPropagation()}>
				<Menu
					label={`Thao tác cho ${folder.name}`}
					trigger={({ toggle }) => <IconButton icon="ellipsis" label="Thao tác" size="sm" onClick={toggle} />}
					items={menuItems}
				/>
			</div>
			<div className="file-card__top">
				<div className="file-card__open">
					<span className="file-card__preview">
						<span className="file-card__icon tone-folder">
							<Icon name="folder" />
						</span>
					</span>
					<span className="file-card__name clamp-2" title={folder.name}>
						{folder.name}
					</span>
					<span className="file-card__meta">Thư mục · {formatRelative(folder.createdAt)}</span>
				</div>
			</div>
		</article>
	);
}

function FileCard({
	file,
	selected,
	onOpen,
	onToggle,
	menuItems,
}: {
	file: FileEntry;
	selected: boolean;
	onOpen: () => void;
	onToggle: () => void;
	menuItems: React.ComponentProps<typeof Menu>['items'];
}) {
	const kind = fileKind(file.name, file.contentType);
	const longPress = useLongPress(onToggle);
	return (
		<article
			className="file-card"
			data-selected={selected}
			tabIndex={0}
			onPointerDown={longPress.onPointerDown}
			onPointerUp={longPress.onPointerUp}
			onPointerLeave={longPress.onPointerLeave}
			onPointerCancel={longPress.onPointerCancel}
			onClick={(event) => {
				if (longPress.consume()) {
					event.preventDefault();
					return;
				}
				const onBody = (event.target as HTMLElement).closest('.file-card__open');
				if (onBody && isTouchPointer() && event.detail === 1) {
					event.stopPropagation();
					onOpen();
					return;
				}
				onToggle();
			}}
			onDoubleClick={(event) => {
				event.stopPropagation();
				if (isTouchPointer()) return;
				onOpen();
			}}
			onKeyDown={(event) => {
				if (event.key === 'Enter') {
					event.preventDefault();
					onOpen();
				}
			}}
			title="Bấm để chọn · bấm đúp để mở"
		>
			<div className="file-card__actions" onClick={(event) => event.stopPropagation()}>
				<Menu
					label={`Thao tác cho ${file.name}`}
					trigger={({ toggle }) => <IconButton icon="ellipsis" label="Thao tác" size="sm" onClick={toggle} />}
					items={menuItems}
				/>
			</div>
			<div className="file-card__top">
				<div className="file-card__open">
					<span className="file-card__preview">
						<span className={`file-card__icon ${kind.tone}`}>
							<Icon name={kind.icon} />
						</span>
					</span>
					<span className="file-card__name clamp-2" title={file.name}>
						{file.name}
					</span>
					<span className="file-card__meta">
						{formatBytes(file.size)} · {formatRelative(file.updatedAt)}
					</span>
				</div>
			</div>
		</article>
	);
}
