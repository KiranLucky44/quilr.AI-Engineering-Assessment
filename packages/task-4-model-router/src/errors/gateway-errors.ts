export type GatewayErrorCode =
  | 'RATE_LIMIT_EXCEEDED'
  | 'UNAUTHORIZED'
  | 'INVALID_REQUEST'
  | 'MODEL_UNAVAILABLE'
  | 'UPSTREAM_TIMEOUT';

export interface StandardizedErrorPayload {
  readonly error: {
    readonly code: GatewayErrorCode;
    readonly message: string;
    readonly request_id: string;
    readonly retry_after_ms?: number;
  };
}

/**
 * Sanitized public error surfaced by the Task 4 gateway.
 * Never carries upstream stack traces, filesystem paths, SQLite internals, or credentials.
 */
export class GatewayError extends Error {
  public readonly code: GatewayErrorCode;
  public readonly httpStatus: number;
  public readonly retryAfterMs: number | undefined;

  public constructor(
    code: GatewayErrorCode,
    httpStatus: number,
    publicMessage: string,
    retryAfterMs?: number,
  ) {
    super(publicMessage);
    this.name = 'GatewayError';
    this.code = code;
    this.httpStatus = httpStatus;
    this.retryAfterMs = retryAfterMs;
  }

  public toResponsePayload(requestId: string): StandardizedErrorPayload {
    return {
      error: {
        code: this.code,
        message: this.message,
        request_id: requestId,
        ...(this.retryAfterMs !== undefined ? { retry_after_ms: this.retryAfterMs } : {}),
      },
    };
  }
}

export class ProviderHttpError extends Error {
  public readonly providerName: string;
  public readonly statusCode: number;

  public constructor(providerName: string, statusCode: number, internalDetail: string) {
    super(internalDetail);
    this.name = 'ProviderHttpError';
    this.providerName = providerName;
    this.statusCode = statusCode;
  }
}

export class ProviderTimeoutError extends Error {
  public readonly providerName: string;
  public readonly timeoutMs: number;

  public constructor(providerName: string, timeoutMs: number) {
    super(`Provider ${providerName} exceeded timeout of ${timeoutMs}ms`);
    this.name = 'ProviderTimeoutError';
    this.providerName = providerName;
    this.timeoutMs = timeoutMs;
  }
}
