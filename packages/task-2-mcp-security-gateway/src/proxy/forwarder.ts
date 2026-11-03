import type { Role } from '../auth/roles.js';
import {
  buildJsonRpcError,
  MCP_DOWNSTREAM_TIMEOUT_ERROR,
  MCP_DOWNSTREAM_UNAVAILABLE_ERROR,
  type JsonRpcErrorEnvelope,
  type JsonRpcId,
  type JsonRpcRequestEnvelope,
} from './request-validator.js';

export interface ForwarderOptions {
  readonly downstreamUrl: string;
  readonly timeoutMs: number;
  readonly fetchImpl?: typeof fetch;
}

export type ForwardResult =
  | {
      readonly kind: 'notification_accepted';
    }
  | {
      readonly kind: 'jsonrpc_response';
      readonly httpStatus: number;
      readonly body: Record<string, unknown>;
    }
  | {
      readonly kind: 'upstream_failure';
      readonly httpStatus: 502 | 504;
      readonly errorEnvelope: JsonRpcErrorEnvelope;
    };

function isTimeoutError(err: unknown): boolean {
  if (!(err instanceof Error)) {
    return false;
  }
  return err.name === 'TimeoutError' || err.name === 'AbortError';
}

/**
 * Forwards permitted JSON-RPC requests to the downstream HTTP MCP server.
 * Never forwards caller Bearer credentials downstream and sanitizes all upstream failures.
 */
export class DownstreamForwarder {
  private readonly downstreamUrl: string;
  private readonly timeoutMs: number;
  private readonly fetchImpl: typeof fetch;

  public constructor(options: ForwarderOptions) {
    this.downstreamUrl = options.downstreamUrl;
    this.timeoutMs = options.timeoutMs;
    this.fetchImpl = options.fetchImpl ?? fetch;
  }

  public async forward(
    envelope: JsonRpcRequestEnvelope,
    isNotification: boolean,
    role: Role,
    requestIdHeader: string,
  ): Promise<ForwardResult> {
    const responseId: JsonRpcId = envelope.id ?? null;

    let response: Response;
    try {
      response = await this.fetchImpl(this.downstreamUrl, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          accept: 'application/json',
          'x-request-id': requestIdHeader,
          'x-authenticated-role': role,
        },
        body: JSON.stringify(envelope),
        signal: AbortSignal.timeout(this.timeoutMs),
      });
    } catch (err) {
      if (isTimeoutError(err)) {
        return {
          kind: 'upstream_failure',
          httpStatus: 504,
          errorEnvelope: buildJsonRpcError(
            responseId,
            MCP_DOWNSTREAM_TIMEOUT_ERROR,
            'Downstream MCP server request timed out',
          ),
        };
      }

      return {
        kind: 'upstream_failure',
        httpStatus: 502,
        errorEnvelope: buildJsonRpcError(
          responseId,
          MCP_DOWNSTREAM_UNAVAILABLE_ERROR,
          'Downstream MCP server is unavailable',
        ),
      };
    }

    if (isNotification && (response.status === 202 || response.status === 204)) {
      return { kind: 'notification_accepted' };
    }

    if (response.status >= 500) {
      return {
        kind: 'upstream_failure',
        httpStatus: 502,
        errorEnvelope: buildJsonRpcError(
          responseId,
          MCP_DOWNSTREAM_UNAVAILABLE_ERROR,
          'Downstream MCP server returned an upstream error',
        ),
      };
    }

    let rawText: string;
    try {
      rawText = await response.text();
    } catch {
      return {
        kind: 'upstream_failure',
        httpStatus: 502,
        errorEnvelope: buildJsonRpcError(
          responseId,
          MCP_DOWNSTREAM_UNAVAILABLE_ERROR,
          'Failed to read response from downstream MCP server',
        ),
      };
    }

    if (isNotification && rawText.trim().length === 0) {
      return { kind: 'notification_accepted' };
    }

    try {
      const parsed: unknown = JSON.parse(rawText);
      if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
        return {
          kind: 'upstream_failure',
          httpStatus: 502,
          errorEnvelope: buildJsonRpcError(
            responseId,
            MCP_DOWNSTREAM_UNAVAILABLE_ERROR,
            'Downstream MCP server returned an invalid JSON-RPC object',
          ),
        };
      }

      return {
        kind: 'jsonrpc_response',
        httpStatus: 200,
        body: parsed as Record<string, unknown>,
      };
    } catch {
      return {
        kind: 'upstream_failure',
        httpStatus: 502,
        errorEnvelope: buildJsonRpcError(
          responseId,
          MCP_DOWNSTREAM_UNAVAILABLE_ERROR,
          'Downstream MCP server returned malformed JSON',
        ),
      };
    }
  }
}
