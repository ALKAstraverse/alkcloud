export type Id = string;

export type IsoDate = string;

export interface Owner {
	id: Id;
	email: string;
	authVerifierHash: string;
	authVerifierSalt: string;
	authParams: string;
	pepperVersion: number;
	createdAt: IsoDate;
	updatedAt: IsoDate;
}

export interface Session {
	id: Id;
	ownerId: Id;
	tokenHash: string;
	csrfSecret: string;
	createdAt: IsoDate;
	expiresAt: IsoDate;
	lastSeenAt: IsoDate;
	revokedAt: IsoDate | null;
	userAgent: string | null;
}

export interface Folder {
	id: Id;
	parentId: Id | null;
	name: string;
	nameLower: string;
	depth: number;
	createdAt: IsoDate;
	updatedAt: IsoDate;
	deletedAt: IsoDate | null;
	deletedBatchId: Id | null;
	version: number;
}

export interface FileItem {
	id: Id;
	folderId: Id | null;
	name: string;
	nameLower: string;
	size: number;
	contentType: string;
	objectKey: string;
	revisionId: Id;
	etag: string | null;
	checksumSha256: string | null;
	createdAt: IsoDate;
	updatedAt: IsoDate;
	deletedAt: IsoDate | null;
	deletedBatchId: Id | null;
	purgeAfter: IsoDate | null;
	version: number;
}

export interface Share {
	id: Id;
	fileId: Id;
	tokenHash: string;
	passwordHash: string | null;
	expiresAt: IsoDate;
	maxDownloads: number | null;
	downloadCount: number;
	revokedAt: IsoDate | null;
	createdAt: IsoDate;
	updatedAt: IsoDate;
}

export type UploadStatus = 'OPEN' | 'COMPLETING' | 'COMPLETED' | 'ABORTED' | 'EXPIRED';

export interface UploadSession {
	id: Id;
	fileName: string;
	fileNameLower: string;
	folderId: Id | null;
	contentType: string;
	totalSize: number;
	objectKey: string;
	/** fileId dự kiến — file row dùng chung id này khi complete. */
	fileId: Id | null;
	revisionId: Id | null;
	partSize: number;
	partCount: number;
	uploadedParts: number;
	status: UploadStatus;
	reservedBytes: number;
	createdAt: IsoDate;
	updatedAt: IsoDate;
	expiresAt: IsoDate;
}

export type AuditSeverity = 'info' | 'security' | 'data_change' | 'system';

export type AuditAction =
	| 'auth.bootstrap'
	| 'auth.login.success'
	| 'auth.login.failure'
	| 'auth.logout'
	| 'auth.session.revoke'
	| 'auth.session.rotate'
	| 'auth.password.change'
	| 'auth.recovery_code.use'
	| 'auth.recovery_code.reset'
	| 'share.unlock'
	| 'share.unlock.failure'
	| 'share.create'
	| 'share.update'
	| 'share.revoke'
	| 'file.create'
	| 'file.delete'
	| 'file.purge'
	| 'file.restore'
	| 'file.rename'
	| 'file.move'
	| 'folder.create'
	| 'folder.rename'
	| 'folder.delete'
	| 'folder.move'
	| 'folder.restore'
	| 'upload.session.create'
	| 'upload.session.abort'
	| 'upload.session.expire'
	| 'system.quota_mode.change'
	| 'system.settings.change'
	| 'system.key.rotate';

export interface AuditEvent {
	id: Id;
	action: AuditAction;
	severity: AuditSeverity;
	actor: string;
	targetType: string | null;
	targetId: string | null;
	metadata: Record<string, unknown>;
	ip: string | null;
	createdAt: IsoDate;
}

export type DegradationMode = 'NORMAL' | 'CONSERVE' | 'READ_ONLY' | 'EMERGENCY';

export interface UsageState {
	mode: DegradationMode;
	reason: string;
	accountRequestsUsed: number;
	accountRequestLimit: number;
	alkApiCallsUsed: number;
	alkApiBudget: number;
	evaluatedAt: IsoDate;
	consecutiveBelow: number;
	lastChangedAt: IsoDate;
	updatedAt: IsoDate;
}

export interface QuotaEvaluationState {
	mode: DegradationMode;
	consecutiveBelow: number;
	lastChangedAtMs: number;
	reason: string;
}

export interface StoredUsage {
	apiCalls: number;
	uploadsStarted: number;
	uploadsCompleted: number;
	downloads: number;
	bytesUploaded: number;
	bytesDownloaded: number;
	shareDownloads: number;
}
