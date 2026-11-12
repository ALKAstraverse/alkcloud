export type ErrorCode =
	| 'bad_request'
	| 'unauthorized'
	| 'forbidden'
	| 'not_found'
	| 'conflict'
	| 'payload_too_large'
	| 'range_not_satisfiable'
	| 'too_many_requests'
	| 'quota_exceeded'
	| 'maintenance'
	| 'internal_error'
	| 'not_configured'
	| 'storage_error'
	| 'database_error';

const STATUS_BY_CODE: Record<ErrorCode, number> = {
	bad_request: 400,
	unauthorized: 401,
	forbidden: 403,
	not_found: 404,
	conflict: 409,
	payload_too_large: 413,
	range_not_satisfiable: 416,
	too_many_requests: 429,
	quota_exceeded: 429,
	maintenance: 503,
	internal_error: 500,
	not_configured: 503,
	storage_error: 502,
	database_error: 500,
};

export class AppError extends Error {
	readonly code: ErrorCode;
	readonly status: number;
	readonly details: Record<string, unknown> | undefined;
	readonly headers: Record<string, string> | undefined;

	constructor(
		code: ErrorCode,
		message: string,
		options: { details?: Record<string, unknown>; headers?: Record<string, string> } = {},
	) {
		super(message);
		this.name = 'AppError';
		this.code = code;
		this.status = STATUS_BY_CODE[code];
		this.details = options.details;
		this.headers = options.headers;
	}

	static badRequest(message: string, details?: Record<string, unknown>): AppError {
		return new AppError('bad_request', message, details ? { details } : {});
	}

	static unauthorized(message = 'Authentication required'): AppError {
		return new AppError('unauthorized', message);
	}

	static forbidden(message = 'Forbidden'): AppError {
		return new AppError('forbidden', message);
	}

	static notFound(message = 'Not found'): AppError {
		return new AppError('not_found', message);
	}

	static conflict(message: string, details?: Record<string, unknown>): AppError {
		return new AppError('conflict', message, details ? { details } : {});
	}

	static quota(message: string, retryAfterSeconds?: number): AppError {
		return new AppError('quota_exceeded', message, {
			headers: retryAfterSeconds ? { 'Retry-After': String(retryAfterSeconds) } : undefined,
		});
	}

	static rateLimited(message: string, retryAfterSeconds?: number): AppError {
		return new AppError('too_many_requests', message, {
			headers: retryAfterSeconds ? { 'Retry-After': String(retryAfterSeconds) } : undefined,
		});
	}

	static notConfigured(message: string): AppError {
		return new AppError('not_configured', message);
	}
}

export function isAppError(value: unknown): value is AppError {
	return value instanceof AppError;
}
