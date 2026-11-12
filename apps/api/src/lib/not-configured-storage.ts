import type {
	MultipartPart,
	ObjectStat,
	ObjectStorage,
	ObjectVersion,
	PresignPartRequest,
	PresignPutRequest,
	PresignedTarget,
} from '@alkcloud/storage';
import { AppError } from '@alkcloud/core';

/**
 * Storage chưa được cấu hình (thiếu B2 endpoint/bucket/key).
 * Mọi lời gọi đều ném NOT_CONFIGURED — KHÔNG giả vờ thành công.
 */
export class NotConfiguredStorage implements ObjectStorage {
	private fail(): never {
		throw AppError.notConfigured(
			'B2 chưa được cấu hình (cần B2_ENDPOINT, B2_REGION, B2_BUCKET, B2_ACCESS_KEY_ID, B2_SECRET_ACCESS_KEY)',
		);
	}

	async presignPut(_request: PresignPutRequest): Promise<PresignedTarget> {
		this.fail();
	}
	async presignUploadPart(_request: PresignPartRequest): Promise<PresignedTarget> {
		this.fail();
	}
	async presignGet(_request: { key: string; expiresInSeconds?: number }): Promise<PresignedTarget> {
		this.fail();
	}
	async createMultipartUpload(_request: { key: string; contentType: string }): Promise<{ uploadId: string }> {
		this.fail();
	}
	async completeMultipartUpload(_request: {
		key: string;
		uploadId: string;
		parts: MultipartPart[];
	}): Promise<{ etag: string | null; size: number | null }> {
		this.fail();
	}
	async abortMultipartUpload(_request: { key: string; uploadId: string }): Promise<void> {
		this.fail();
	}
	async listParts(_request: { key: string; uploadId: string }): Promise<MultipartPart[]> {
		this.fail();
	}
	async headObject(_key: string): Promise<ObjectStat | null> {
		this.fail();
	}
	async getObject(_key: string, _range?: string): Promise<Response> {
		this.fail();
	}
	async deleteObject(_key: string): Promise<void> {
		this.fail();
	}
	async listObjectVersions(_key: string): Promise<ObjectVersion[]> {
		this.fail();
	}
	async deleteObjectVersion(_key: string, _versionId: string): Promise<void> {
		this.fail();
	}
}
