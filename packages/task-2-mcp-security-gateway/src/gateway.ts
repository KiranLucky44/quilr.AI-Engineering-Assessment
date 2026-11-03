import { randomUUID } from 'node:crypto';
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';
import { TokenVerifier } from './auth/token-verifier.js';
import { evaluateToolAuthorization } from './proxy/authorization-policy.js';
import { DownstreamForwarder } from './proxy/forwarder.js';
import {
  buildJsonRpcError,
  JSONRPC_INTERNAL_ERROR,
  parseAndValidateJsonRpcBody,
} from './proxy/request-validator.js';

export interface GatewayLogEvent {
  readonly timestamp: string;
  readonly level: 'info' | 'warn' | 'error';
  readonly event: string;
  readonly requestId: string;
  readonly meta?: Record<string, unknown>;
}

export type GatewayLogSink = (entry: GatewayLogEvent) => void;

export interface SecurityGatewayOptions {
  readonly downstreamMcpUrl: string;
  readonly adminToken: string;
  readonly viewerToken: string;
  readonly requestTimeoutMs?: number;
  readonly maxBodyBytes?: number;
  readonly fetchImpl?: typeof fetch;
  readonly logSink?: GatewayLogSink;
}

export interface SecurityGatewayHandle {
  readonly server: Server;
  listen(port: number, host?: string): Promise<number>;
  close(): Promise<void>;
}

class PayloadTooLargeError extends Error {
  public constructor() {
    super('Request body exceeds configured limit');
    this.name = 'PayloadTooLargeError';
  }
}

function defaultStderrLogSink(entry: GatewayLogEvent): void {
  process.stderr.write(`${JSON.stringify(entry)}\n`);
}

function isJsonContentType(contentTypeHeader: string | undefined): boolean {
  if (!contentTypeHeader) {
    return false;
  }
  const mediaType = contentTypeHeader.split(';')[0]?.trim().toLowerCase();
  return mediaType === 'application/json';
}

function readBoundedBody(req: IncomingMessage, maxBytes: number): Promise<string> {
  return new Promise((resolvePromise, rejectPromise) => {
    const contentLengthHeader = req.headers['content-length'];
    if (contentLengthHeader !== undefined) {
      const declaredLength = Number.parseInt(contentLengthHeader, 10);
      if (Number.isFinite(declaredLength) && declaredLength > maxBytes) {
        req.resume();
        rejectPromise(new PayloadTooLargeError());
        return;
      }
    }

    const chunks: Buffer[] = [];
    let receivedBytes = 0;
    let settled = false;

    req.on('data', (chunk: Buffer) => {
      if (settled) {
        return;
      }
      receivedBytes += chunk.length;
      if (receivedBytes > maxBytes) {
        settled = true;
        req.resume();
        rejectPromise(new PayloadTooLargeError());
        return;
      }
      chunks.push(chunk);
    });

    req.on('end', () => {
      if (settled) {
        return;
      }
      settled = true;
      resolvePromise(Buffer.concat(chunks).toString('utf8'));
    });

    req.on('error', (err) => {
      if (settled) {
        return;
      }
      settled = true;
      rejectPromise(err);
    });
  });
}

function writeJsonResponse(
  res: ServerResponse,
  statusCode: number,
  requestId: string,
  payload: unknown,
  extraHeaders?: Record<string, string>,
): void {
  const serialized = JSON.stringify(payload);
  res.writeHead(statusCode, {
    'content-type': 'application/json; charset=utf-8',
    'content-length': Buffer.byteLength(serialized),
    'cache-control': 'no-store',
    'x-request-id': requestId,
    ...extraHeaders,
  });
  res.end(serialized);
}

/**
 * Creates the HTTP JSON-RPC MCP Security Gateway reverse proxy.
 *
 * Security guarantees:
 * - Authenticates Bearer credentials before inspecting or forwarding payloads.
 * - Never logs or echoes Authorization headers or bearer token values.
 * - Enforces tool-level RBAC (`admin_` prefix requires `admin` role) prior to upstream forwarding.
 * - Enforces Content-Type, request body size limits, and upstream request timeouts.
 * - Sanitizes all downstream errors so upstream stack traces or internal hosts never leak.
 */
export function createMcpSecurityGateway(options: SecurityGatewayOptions): SecurityGatewayHandle {
  const maxBodyBytes = options.maxBodyBytes ?? 65536;
  const requestTimeoutMs = options.requestTimeoutMs ?? 5000;
  const log = options.logSink ?? defaultStderrLogSink;

  const verifier = new TokenVerifier({
    adminToken: options.adminToken,
    viewerToken: options.viewerToken,
  });

  const forwarder = new DownstreamForwarder({
    downstreamUrl: options.downstreamMcpUrl,
    timeoutMs: requestTimeoutMs,
    ...(options.fetchImpl ? { fetchImpl: options.fetchImpl } : {}),
  });

  const emitLog = (
    level: GatewayLogEvent['level'],
    event: string,
    requestId: string,
    meta?: Record<string, unknown>,
  ): void => {
    log({
      timestamp: new Date().toISOString(),
      level,
      event,
      requestId,
      ...(meta ? { meta } : {}),
    });
  };

  const handleMcpRequest = async (
    req: IncomingMessage,
    res: ServerResponse,
    requestId: string,
  ): Promise<void> => {
    const authHeader =
      typeof req.headers['authorization'] === 'string' ? req.headers['authorization'] : undefined;
    const verification = verifier.verifyAuthorizationHeader(authHeader);

    if (!verification.authenticated) {
      emitLog('warn', 'auth.rejected', requestId, { reason: verification.reason });
      writeJsonResponse(
        res,
        401,
        requestId,
        {
          error: {
            code: 'UNAUTHORIZED',
            message: 'Missing or invalid bearer credentials.',
            request_id: requestId,
          },
        },
        { 'www-authenticate': 'Bearer realm="mcp-security-gateway"' },
      );
      return;
    }

    const { principal } = verification;

    if (!isJsonContentType(req.headers['content-type'])) {
      emitLog('warn', 'request.unsupported_media_type', requestId, {
        role: principal.role,
        tokenFingerprint: principal.tokenFingerprint,
      });
      writeJsonResponse(res, 415, requestId, {
        error: {
          code: 'UNSUPPORTED_MEDIA_TYPE',
          message: 'Content-Type must be application/json.',
          request_id: requestId,
        },
      });
      return;
    }

    let rawBody: string;
    try {
      rawBody = await readBoundedBody(req, maxBodyBytes);
    } catch (err) {
      if (err instanceof PayloadTooLargeError) {
        emitLog('warn', 'request.payload_too_large', requestId, {
          role: principal.role,
          maxBodyBytes,
        });
        writeJsonResponse(res, 413, requestId, {
          error: {
            code: 'PAYLOAD_TOO_LARGE',
            message: `Request body exceeds maximum size of ${maxBodyBytes} bytes.`,
            request_id: requestId,
          },
        });
        return;
      }

      emitLog('error', 'request.stream_error', requestId);
      writeJsonResponse(
        res,
        400,
        requestId,
        buildJsonRpcError(null, JSONRPC_INTERNAL_ERROR, 'Failed to read request body'),
      );
      return;
    }

    const validation = parseAndValidateJsonRpcBody(rawBody);
    if (!validation.valid) {
      emitLog('warn', 'jsonrpc.validation_failed', requestId, {
        role: principal.role,
        code: validation.errorEnvelope.error.code,
      });
      if (validation.isNotification) {
        res.writeHead(204, { 'x-request-id': requestId });
        res.end();
        return;
      }
      writeJsonResponse(res, validation.httpStatus, requestId, validation.errorEnvelope);
      return;
    }

    const { request: rpcRequest } = validation;
    const authz = evaluateToolAuthorization(principal.role, rpcRequest.method, rpcRequest.toolName);

    if (!authz.allowed) {
      emitLog('warn', 'authz.denied_tool_call', requestId, {
        role: principal.role,
        tokenFingerprint: principal.tokenFingerprint,
        method: rpcRequest.method,
        toolName: rpcRequest.toolName,
      });

      if (rpcRequest.isNotification) {
        res.writeHead(204, { 'x-request-id': requestId });
        res.end();
        return;
      }

      writeJsonResponse(
        res,
        200,
        requestId,
        buildJsonRpcError(rpcRequest.id ?? null, authz.errorCode, authz.errorMessage),
      );
      return;
    }

    emitLog('info', 'proxy.forwarding', requestId, {
      role: principal.role,
      tokenFingerprint: principal.tokenFingerprint,
      method: rpcRequest.method,
      ...(rpcRequest.toolName ? { toolName: rpcRequest.toolName } : {}),
    });

    const upstreamResult = await forwarder.forward(
      rpcRequest.envelope,
      rpcRequest.isNotification,
      principal.role,
      requestId,
    );

    if (upstreamResult.kind === 'notification_accepted') {
      res.writeHead(204, { 'x-request-id': requestId });
      res.end();
      return;
    }

    if (upstreamResult.kind === 'upstream_failure') {
      emitLog('error', 'proxy.downstream_error', requestId, {
        httpStatus: upstreamResult.httpStatus,
        code: upstreamResult.errorEnvelope.error.code,
      });
      writeJsonResponse(res, upstreamResult.httpStatus, requestId, upstreamResult.errorEnvelope);
      return;
    }

    writeJsonResponse(res, upstreamResult.httpStatus, requestId, upstreamResult.body);
  };

  const server = createServer((req, res) => {
    const requestId = `req_${randomUUID()}`;
    const urlPath = (req.url ?? '/').split('?')[0];

    if (req.method === 'GET' && urlPath === '/health') {
      writeJsonResponse(res, 200, requestId, {
        status: 'ok',
        service: 'mcp-security-gateway',
      });
      return;
    }

    if (urlPath !== '/mcp') {
      writeJsonResponse(res, 404, requestId, {
        error: {
          code: 'NOT_FOUND',
          message: 'Endpoint not found. Use POST /mcp.',
          request_id: requestId,
        },
      });
      return;
    }

    if (req.method !== 'POST') {
      writeJsonResponse(
        res,
        405,
        requestId,
        {
          error: {
            code: 'METHOD_NOT_ALLOWED',
            message: 'Only POST is supported on /mcp.',
            request_id: requestId,
          },
        },
        { allow: 'POST' },
      );
      return;
    }

    void handleMcpRequest(req, res, requestId).catch(() => {
      emitLog('error', 'gateway.unhandled_exception', requestId);
      if (!res.headersSent) {
        writeJsonResponse(
          res,
          500,
          requestId,
          buildJsonRpcError(null, JSONRPC_INTERNAL_ERROR, 'Internal gateway error'),
        );
      } else {
        res.end();
      }
    });
  });

  server.requestTimeout = requestTimeoutMs + 2000;
  server.headersTimeout = Math.min(requestTimeoutMs + 1000, 10000);

  return {
    server,
    listen: (port: number, host = '127.0.0.1'): Promise<number> =>
      new Promise((resolvePromise, rejectPromise) => {
        server.once('error', rejectPromise);
        server.listen(port, host, () => {
          server.removeListener('error', rejectPromise);
          const addr = server.address() as AddressInfo;
          resolvePromise(addr.port);
        });
      }),
    close: (): Promise<void> =>
      new Promise((resolvePromise, rejectPromise) => {
        if (!server.listening) {
          resolvePromise();
          return;
        }
        server.closeIdleConnections();
        server.close((err) => {
          if (err) {
            rejectPromise(err);
            return;
          }
          resolvePromise();
        });
      }),
  };
}
