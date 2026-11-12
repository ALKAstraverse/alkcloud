import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
	ApiError,
	createFolder,
	createShare,
	deleteFile,
	deleteFolder,
	getQuota,
	getUsage,
	listFiles,
	listFolders,
	listTrash,
	listTrashFolders,
	logout,
	fileDownloadUrl,
	openFileUrl,
	purgeFile,
	renameFile,
	renameFolder,
	restoreFile,
	restoreFolder,
} from '../lib/api.js';
import { deriveShareVerifier, randomSalt } from '../lib/argon2.js';
import { uploadFiles, type UploadProgress } from '../lib/upload.js';

interface FilesPageProps {
	onLogout: () => void;
}

function formatBytes(bytes: number): string {
	if (bytes < 1024) return `${bytes} B`;
	const units = ['KB', 'MB', 'GB', 'TB'];
	let value = bytes / 1024;
	let unit = 0;
	while (value >= 1024 && unit < units.length - 1) {
		value /= 1024;
		unit += 1;
	}
	return `${value.toFixed(1)} ${units[unit]}`;
}

export function FilesPage({ onLogout }: FilesPageProps) {
	const [folderId, setFolderId] = useState<string | null>(null);
	const [breadcrumb, setBreadcrumb] = useState<{ id: string; name: string }[]>([]);
	const [files, setFiles] = useState<Awaited<ReturnType<typeof listFiles>>['files']>([]);
	const [folders, setFolders] = useState<Awaited<ReturnType<typeof listFolders>>['folders']>([]);
	const [trash, setTrash] = useState<Awaited<ReturnType<typeof listTrash>>['files']>([]);
	const [trashFolders, setTrashFolders] = useState<Awaited<ReturnType<typeof listTrashFolders>>['folders']>([]);
	const [query, setQuery] = useState('');
	const [view, setView] = useState<'files' | 'trash'>('files');
	const [mode, setMode] = useState<string>('NORMAL');
	const [usage, setUsage] = useState<{ quotaBytes: number; usedBytes: number; reservedBytes: number } | null>(null);
	const [message, setMessage] = useState<string | null>(null);
	const [error, setError] = useState<string | null>(null);
	const [busy, setBusy] = useState(false);
	const [progress, setProgress] = useState<UploadProgress | null>(null);
	const [shareUrl, setShareUrl] = useState<string | null>(null);
	const fileInput = useRef<HTMLInputElement>(null);

	const refresh = useCallback(async () => {
		try {
			const [fileResult, folderResult] = await Promise.all([
				listFiles({ parentId: folderId, q: query || undefined }),
				listFolders(folderId),
			]);
			setFiles(fileResult.files);
			setFolders(folderResult.folders);
			const [quota, usageResult, trashResult, trashFolderResult] = await Promise.all([
				getQuota(),
				getUsage(),
				listTrash(),
				listTrashFolders(),
			]);
			setMode(quota.mode);
			setUsage(usageResult);
			setTrash(trashResult.files);
			setTrashFolders(trashFolderResult.folders);
			setError(null);
		} catch (caught) {
			setError(caught instanceof ApiError ? caught.message : 'Không tải được danh sách');
		}
	}, [folderId, query]);

	useEffect(() => {
		void refresh();
	}, [refresh]);

	const usagePercent = useMemo(() => {
		if (!usage || usage.quotaBytes <= 0) return 0;
		return Math.min(100, ((usage.usedBytes + usage.reservedBytes) / usage.quotaBytes) * 100);
	}, [usage]);

	const handleUpload = async (fileList: FileList | null) => {
		if (!fileList || fileList.length === 0) return;
		setBusy(true);
		setMessage(null);
		setError(null);
		setProgress({ uploadedBytes: 0, totalBytes: 0, partsUploaded: 0, partsTotal: 0 });
		try {
			const result = await uploadFiles(Array.from(fileList), {
				onProgress: setProgress,
				folderId,
			});
			setMessage(`Đã tải lên ${result.uploaded} file${result.failed ? `, thất bại ${result.failed}` : ''}`);
			if (result.errors.length > 0) setError(result.errors.join('; '));
			await refresh();
		} catch (caught) {
			setError(caught instanceof ApiError ? caught.message : 'Tải lên thất bại');
		} finally {
			setBusy(false);
			setProgress(null);
			if (fileInput.current) fileInput.current.value = '';
		}
	};

	const handleShare = async (fileId: string, withPassword: boolean) => {
		setError(null);
		let password: string | null = null;
		if (withPassword) {
			password = window.prompt('Mật khẩu cho link chia sẻ (tối thiểu 8 ký tự)');
			if (!password) return;
			if (password.length < 8) {
				setError('Mật khẩu chia sẻ phải có ít nhất 8 ký tự');
				return;
			}
		}
		setBusy(true);
		try {
			const passwordVerifier = password ? await deriveShareVerifier(password) : null;
			const result = await createShare({
				fileId,
				expiresInDays: 7,
				maxDownloads: null,
				passwordVerifier,
				passwordSalt: password ? randomSalt() : null,
				passwordParams: password ? 'sha256' : null,
			});
			setShareUrl(password ? `${result.url} (mật khẩu: ${password})` : result.url);
		} catch (caught) {
			setError(caught instanceof ApiError ? caught.message : 'Tạo share thất bại');
		} finally {
			setBusy(false);
		}
	};

	// File vừa/nhỏ: tải qua proxy để giữ đúng tên file gốc.
	// File lớn: dùng presigned URL để không phụ thuộc Worker trong suốt quá trình tải.
	const PROXY_DOWNLOAD_LIMIT = 100 * 1024 * 1024;

	const handleDownload = async (fileId: string) => {
		try {
			const result = await openFileUrl(fileId);
			if (result.size <= PROXY_DOWNLOAD_LIMIT) {
				window.location.assign(fileDownloadUrl(fileId));
				return;
			}
			window.location.assign(result.url);
		} catch (caught) {
			setError(caught instanceof ApiError ? caught.message : 'Không mở được file');
		}
	};

	const navigateInto = (id: string, name: string) => {
		setBreadcrumb((current) => [...current, { id, name }]);
		setFolderId(id);
	};

	const navigateUp = () => {
		setBreadcrumb((current) => current.slice(0, -1));
		setFolderId((current) => {
			const next = breadcrumb.slice(0, -1);
			return next.length > 0 ? next[next.length - 1]!.id : null;
		});
	};

	return (
		<main className="app">
			<header>
				<h1>AlkCloud</h1>
				<div className="row">
					<span className={`badge ${mode.toLowerCase()}`}>{mode}</span>
					<button type="button" className="link" onClick={() => void logout().then(onLogout)}>
						Đăng xuất
					</button>
				</div>
			</header>

			{usage && (
				<section className="usage">
					<div className="bar">
						<span style={{ width: `${usagePercent}%` }} />
					</div>
					<p className="muted small">
						{formatBytes(usage.usedBytes)} / {formatBytes(usage.quotaBytes)} đã dùng
						{usage.reservedBytes > 0 ? ` (đang giữ chỗ ${formatBytes(usage.reservedBytes)})` : ''}
					</p>
				</section>
			)}

			<nav className="toolbar">
				<button type="button" onClick={() => setView(view === 'files' ? 'trash' : 'files')}>
					{view === 'files' ? 'Xem thùng rác' : 'Về thư viện'}
				</button>
				<button
					type="button"
					onClick={async () => {
						const name = window.prompt('Tên thư mục mới');
						if (!name) return;
						try {
							await createFolder(name, folderId);
							await refresh();
						} catch (caught) {
							setError(caught instanceof ApiError ? caught.message : 'Tạo thư mục thất bại');
						}
					}}
				>
					Thư mục mới
				</button>
				<button type="button" disabled={busy} onClick={() => fileInput.current?.click()}>
					Tải lên
				</button>
				<input
					ref={fileInput}
					type="file"
					multiple
					hidden
					onChange={(event) => void handleUpload(event.target.files)}
				/>
				<input
					type="search"
					placeholder="Tìm kiếm…"
					value={query}
					onChange={(event) => setQuery(event.target.value)}
				/>
			</nav>

			{view === 'files' ? (
				<>
					<nav className="breadcrumb">
						<button type="button" className="link" onClick={() => { setBreadcrumb([]); setFolderId(null); }}>
							Thư viện
						</button>
						{breadcrumb.map((node, index) => (
							<span key={node.id}>
								{' / '}
								<button
									type="button"
									className="link"
									onClick={() => {
										setBreadcrumb(breadcrumb.slice(0, index + 1));
										setFolderId(node.id);
									}}
								>
									{node.name}
								</button>
							</span>
						))}
						{breadcrumb.length > 0 && (
							<button type="button" className="link" onClick={navigateUp}>
								(lên)
							</button>
						)}
					</nav>

					<table>
						<thead>
							<tr>
								<th>Tên</th>
								<th>Kích thước</th>
								<th>Sửa</th>
								<th />
							</tr>
						</thead>
						<tbody>
							{folders.map((folder) => (
								<tr key={folder.id}>
									<td>
										<button type="button" className="link" onClick={() => navigateInto(folder.id, folder.name)}>
											📁 {folder.name}
										</button>
									</td>
									<td>—</td>
									<td>{folder.createdAt.slice(0, 10)}</td>
									<td className="actions">
										<button
											type="button"
											className="link"
											onClick={async () => {
												const name = window.prompt('Tên mới', folder.name);
												if (!name) return;
												try {
													await renameFolder(folder.id, name);
													await refresh();
												} catch (caught) {
													setError(caught instanceof ApiError ? caught.message : 'Đổi tên thất bại');
												}
											}}
										>
											Đổi tên
										</button>
										<button
											type="button"
											className="link danger"
											onClick={async () => {
												if (!window.confirm(`Xoá thư mục "${folder.name}" và toàn bộ file bên trong?`)) return;
												try {
													await deleteFolder(folder.id);
													await refresh();
												} catch (caught) {
													setError(caught instanceof ApiError ? caught.message : 'Xoá thất bại');
												}
											}}
										>
											Xoá
										</button>
									</td>
								</tr>
							))}
							{files.map((file) => (
								<tr key={file.id}>
									<td>
										<span
											role="button"
											tabIndex={0}
											onClick={() => void handleDownload(file.id)}
											onKeyDown={(event) => {
												if (event.key === 'Enter') void handleDownload(file.id);
											}}
										>
											📄 {file.name}
										</span>
									</td>
									<td>{formatBytes(file.size)}</td>
									<td>{file.updatedAt.slice(0, 10)}</td>
									<td className="actions">
										<button type="button" className="link" onClick={() => void handleShare(file.id, false)}>
											Chia sẻ
										</button>
										<button type="button" className="link" onClick={() => void handleShare(file.id, true)}>
											Chia sẻ (mật khẩu)
										</button>
										<button
											type="button"
											className="link"
											onClick={async () => {
												const name = window.prompt('Tên mới', file.name);
												if (!name) return;
												try {
													await renameFile(file.id, name);
													await refresh();
												} catch (caught) {
													setError(caught instanceof ApiError ? caught.message : 'Đổi tên thất bại');
												}
											}}
										>
											Đổi tên
										</button>
										<button
											type="button"
											className="link danger"
											onClick={async () => {
												try {
													await deleteFile(file.id);
													await refresh();
												} catch (caught) {
													setError(caught instanceof ApiError ? caught.message : 'Xoá thất bại');
												}
											}}
										>
											Xoá
										</button>
									</td>
								</tr>
							))}
						</tbody>
					</table>
				</>
			) : (
				<table>
					<thead>
						<tr>
							<th>Tên</th>
							<th>Xoá lúc</th>
							<th />
						</tr>
					</thead>
					<tbody>
						{trashFolders.map((folder) => (
							<tr key={folder.id}>
								<td>📁 {folder.name}</td>
								<td>{folder.deletedAt?.slice(0, 10) ?? '—'}</td>
								<td>
									<button
										type="button"
										className="link"
										onClick={async () => {
											try {
												await restoreFolder(folder.id);
												await refresh();
											} catch (caught) {
												setError(caught instanceof ApiError ? caught.message : 'Khôi phục thất bại');
											}
										}}
									>
										Khôi phục
									</button>
								</td>
							</tr>
						))}
						{trash.map((file) => (
							<tr key={file.id}>
								<td>{file.name}</td>
								<td>{file.deletedAt?.slice(0, 10)}</td>
								<td>
									<button
										type="button"
										className="link"
										onClick={async () => {
											try {
												await restoreFile(file.id);
												await refresh();
											} catch (caught) {
												setError(caught instanceof ApiError ? caught.message : 'Khôi phục thất bại');
											}
										}}
									>
										Khôi phục
									</button>
									{file.purgeAfter && new Date(file.purgeAfter).getTime() <= Date.now() && (
										<button
											type="button"
											className="link danger"
											onClick={async () => {
												if (!window.confirm(`Xoá vĩnh viễn "${file.name}"?`)) return;
												try {
													await purgeFile(file.id);
													await refresh();
												} catch (caught) {
													setError(caught instanceof ApiError ? caught.message : 'Xoá vĩnh viễn thất bại');
												}
											}}
										>
											Xoá vĩnh viễn
										</button>
									)}
								</td>
							</tr>
						))}
					</tbody>
				</table>
			)}

			{progress && (
				<p className="muted small">
					Đang tải lên: {formatBytes(progress.uploadedBytes)} / {formatBytes(progress.totalBytes)} (
					{progress.partsUploaded}/{progress.partsTotal} part)
				</p>
			)}
			{message && <p className="ok">{message}</p>}
			{error && <p className="error">{error}</p>}
			{shareUrl && (
				<p className="ok">
					URL chia sẻ (hiển thị một lần): <code>{shareUrl}</code>{' '}
					<button type="button" className="link" onClick={() => setShareUrl(null)}>
						Ẩn
					</button>
				</p>
			)}
		</main>
	);
}
