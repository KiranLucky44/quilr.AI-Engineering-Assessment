import { randomUUID } from 'node:crypto';
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';
import { validateChatCompletionRequest } from './middleware/request-validator.js';
import type { LLMStreamProvider } from './providers/llm-provider.interface.js';
import { MockLLMProvider } from './providers/mock-llm.provider.js';
import { UpstreamStreamProviderError } from './providers/ollama.provider.js';
import {
  encodeCompletionChunkSse,
  encodeSseDone,
  encodeSseErrorEvent,
  writeSseWithBackpressure,
} from './streaming/sse-encoder.js';
import { StreamingRedactor } from './streaming/streaming-redactor.js';

export interface StreamingGatewayOptions {
  readonly provider?: LLMStreamProvider;
  readonly maxBodyBytes?: number;
  readonly silentLogs?: boolean;
}

export interface StreamingGatewayHandle {
  readonly server: Server;
  listen(port: number, host?: string): Promise<number>;
  close(): Promise<void>;
}

class PayloadTooLargeError extends Error {
  public constructor() {
    super('Request body too large');
    this.name = 'PayloadTooLargeError';
  }
}

class InvalidUtf8BodyError extends Error {
  public constructor() {
    super('Request body must be valid UTF-8 encoded JSON.');
    this.name = 'InvalidUtf8BodyError';
  }
}

class BodyReadError extends Error {
  public constructor(message: string) {
    super(message);
    this.name = 'BodyReadError';
  }
}

type ContentTypeValidationResult =
  { readonly valid: true } | { readonly valid: false; readonly message: string };

function validateJsonContentType(headerValue: string | undefined): ContentTypeValidationResult {
  if (!headerValue || headerValue.trim().length === 0) {
    return {
      valid: false,
      message: 'Content-Type must be application/json.',
    };
  }

  const segments = headerValue.split(';');
  const mediaType = segments[0]?.trim().toLowerCase();
  if (mediaType !== 'application/json') {
    return {
      valid: false,
      message: 'Content-Type must be application/json.',
    };
  }

  for (let i = 1; i < segments.length; i += 1) {
    const param = segments[i]?.trim() ?? '';
    if (param.length === 0) {
      continue;
    }
    const eqIndex = param.indexOf('=');
    if (eqIndex === -1) {
      continue;
    }
    const key = param.slice(0, eqIndex).trim().toLowerCase();
    if (key === 'charset') {
      const rawCharset = param
        .slice(eqIndex + 1)
        .trim()
        .replace(/^"(.*)"$/, '$1')
        .toLowerCase();
      if (rawCharset !== 'utf-8' && rawCharset !== 'utf8') {
        return {
          valid: false,
          message: 'Unsupported Content-Type charset; only UTF-8 is supported.',
        };
      }
    }
  }

  return { valid: true };
}

export function readBoundedBody(req: IncomingMessage, maxBytes: number): Promise<string> {
  if (req.readableEnded || req.readableFlowing !== null) {
    return Promise.reject(new BodyReadError('Request body stream has already been consumed.'));
  }

  return new Promise((resolvePromise, rejectPromise) => {
    let expectedBytes: number | null = null;
    const declared = req.headers['content-length'];
    if (declared !== undefined) {
      const trimmedDeclared = declared.trim();
      if (!/^\d+$/.test(trimmedDeclared)) {
        req.resume();
        rejectPromise(new BodyReadError('Invalid Content-Length header.'));
        return;
      }
      const parsedLength = Number.parseInt(trimmedDeclared, 10);
      if (!Number.isSafeInteger(parsedLength) || parsedLength < 0) {
        req.resume();
        rejectPromise(new BodyReadError('Invalid Content-Length header.'));
        return;
      }
      if (parsedLength > maxBytes) {
        req.resume();
        rejectPromise(new PayloadTooLargeError());
        return;
      }
      expectedBytes = parsedLength;
    }

    const chunks: Buffer[] = [];
    let total = 0;
    let settled = false;

    const cleanup = (): void => {
      req.removeListener('data', onData);
      req.removeListener('end', onEnd);
      req.removeListener('error', onError);
      req.removeListener('aborted', onAborted);
      req.removeListener('close', onClose);
    };

    const onData = (chunk: Buffer | string): void => {
      if (settled) {
        return;
      }
      const buf = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk, 'utf8');
      total += buf.byteLength;
      if (total > maxBytes) {
        settled = true;
        cleanup();
        req.resume();
        rejectPromise(new PayloadTooLargeError());
        return;
      }
      chunks.push(buf);
    };

    const onEnd = (): void => {
      if (settled) {
        return;
      }
      settled = true;
      cleanup();

      if (!req.complete || (expectedBytes !== null && total !== expectedBytes)) {
        rejectPromise(new BodyReadError('Incomplete HTTP request body.'));
        return;
      }

      const rawBytes =
        chunks.length === 1 ? (chunks[0] ?? Buffer.alloc(0)) : Buffer.concat(chunks, total);
      try {
        const utf8Decoder = new TextDecoder('utf-8', { fatal: true });
        const decoded = utf8Decoder.decode(rawBytes);
        resolvePromise(decoded);
      } catch {
        rejectPromise(new InvalidUtf8BodyError());
      }
    };

    const onError = (err: Error): void => {
      if (settled) {
        return;
      }
      settled = true;
      cleanup();
      rejectPromise(err);
    };

    const onAborted = (): void => {
      if (settled) {
        return;
      }
      settled = true;
      cleanup();
      rejectPromise(new BodyReadError('Client aborted HTTP request body upload.'));
    };

    const onClose = (): void => {
      if (settled || req.complete) {
        return;
      }
      settled = true;
      cleanup();
      rejectPromise(new BodyReadError('Connection closed before HTTP request body completed.'));
    };

    req.on('data', onData);
    req.on('end', onEnd);
    req.on('error', onError);
    req.on('aborted', onAborted);
    req.on('close', onClose);
  });
}

function writeJsonError(
  res: ServerResponse,
  statusCode: number,
  code: string,
  message: string,
  requestId: string,
  extraHeaders?: Record<string, string>,
): void {
  const payload = JSON.stringify({
    error: {
      code,
      message,
      request_id: requestId,
    },
  });
  res.writeHead(statusCode, {
    'content-type': 'application/json; charset=utf-8',
    'content-length': Buffer.byteLength(payload),
    'cache-control': 'no-store',
    'x-request-id': requestId,
    ...extraHeaders,
  });
  res.end(payload);
}

/**
 * Creates the Task 3 HTTP LLM Streaming PII Redaction Gateway.
 */
export function createStreamingGuardrailServer(
  options: StreamingGatewayOptions = {},
): StreamingGatewayHandle {
  const provider = options.provider ?? new MockLLMProvider();
  const maxBodyBytes = options.maxBodyBytes ?? 131072;
  const silentLogs = options.silentLogs ?? false;

  const logEvent = (
    level: 'info' | 'warn' | 'error',
    event: string,
    requestId: string,
    meta?: Record<string, unknown>,
  ): void => {
    if (silentLogs) {
      return;
    }
    process.stderr.write(
      `${JSON.stringify({
        timestamp: new Date().toISOString(),
        level,
        component: 'llm-streaming-guardrail',
        event,
        requestId,
        ...(meta ? { meta } : {}),
      })}\n`,
    );
  };

  const handleChatCompletions = async (
    req: IncomingMessage,
    res: ServerResponse,
    requestId: string,
  ): Promise<void> => {
    const contentTypeCheck = validateJsonContentType(req.headers['content-type']);
    if (!contentTypeCheck.valid) {
      writeJsonError(res, 415, 'UNSUPPORTED_MEDIA_TYPE', contentTypeCheck.message, requestId);
      return;
    }

    let rawBody: string;
    try {
      rawBody = await readBoundedBody(req, maxBodyBytes);
    } catch (err) {
      if (err instanceof PayloadTooLargeError) {
        writeJsonError(
          res,
          413,
          'PAYLOAD_TOO_LARGE',
          `Request body exceeds maximum size of ${maxBodyBytes} bytes.`,
          requestId,
        );
        return;
      }
      if (err instanceof InvalidUtf8BodyError) {
        writeJsonError(res, 400, 'INVALID_UTF8', err.message, requestId);
        return;
      }
      const message = err instanceof BodyReadError ? err.message : 'Failed to read request body.';
      writeJsonError(res, 400, 'INVALID_REQUEST', message, requestId);
      return;
    }

    const validation = validateChatCompletionRequest(rawBody);
    if (!validation.valid) {
      logEvent('warn', 'request.validation_failed', requestId, {
        errorCode: validation.errorCode,
        bodyByteLength: Buffer.byteLength(rawBody, 'utf8'),
      });
      writeJsonError(res, 400, validation.errorCode, validation.message, requestId);
      return;
    }

    const abortController = new AbortController();
    let streamFinished = false;

    const onClientDisconnect = (): void => {
      if (!streamFinished && !abortController.signal.aborted) {
        abortController.abort();
        logEvent('info', 'stream.client_disconnected', requestId);
      }
    };

    req.once('aborted', onClientDisconnect);
    res.once('close', onClientDisconnect);

    const ensureSseHeadersSent = (): void => {
      if (!res.headersSent && !res.writableEnded && !res.destroyed) {
        res.writeHead(200, {
          'content-type': 'text/event-stream; charset=utf-8',
          'cache-control': 'no-cache, no-transform',
          connection: 'keep-alive',
          'x-accel-buffering': 'no',
          'x-request-id': requestId,
        });
        res.flushHeaders();
      }
    };

    const redactor = new StreamingRedactor();
    let streamId = `chatcmpl_${requestId}`;
    let streamCreated = Math.floor(Date.now() / 1000);
    let streamModel = validation.data.model;
    let streamFingerprint: string | undefined;
    let sawTerminalFinishReason: 'stop' | 'length' | null = null;

    try {
      for await (const delta of provider.streamChatCompletion(
        validation.data,
        abortController.signal,
      )) {
        if (abortController.signal.aborted) {
          break;
        }

        ensureSseHeadersSent();

        streamId = delta.id;
        streamCreated = delta.created;
        streamModel = delta.model;
        if (delta.systemFingerprint !== undefined) {
          streamFingerprint = delta.systemFingerprint;
        }

        if (delta.role !== undefined && (delta.contentDelta ?? '').length === 0) {
          const ok = await writeSseWithBackpressure(
            res,
            encodeCompletionChunkSse({
              id: streamId,
              created: streamCreated,
              model: streamModel,
              ...(streamFingerprint !== undefined ? { systemFingerprint: streamFingerprint } : {}),
              role: delta.role,
              contentDelta: '',
              finishReason: null,
            }),
            abortController.signal,
          );
          if (!ok) {
            break;
          }
        }

        if (delta.contentDelta !== undefined && delta.contentDelta.length > 0) {
          const safeChunk = redactor.push(delta.contentDelta);
          if (safeChunk.length > 0) {
            const ok = await writeSseWithBackpressure(
              res,
              encodeCompletionChunkSse({
                id: streamId,
                created: streamCreated,
                model: streamModel,
                ...(streamFingerprint !== undefined
                  ? { systemFingerprint: streamFingerprint }
                  : {}),
                ...(delta.role !== undefined ? { role: delta.role } : {}),
                contentDelta: safeChunk,
                finishReason: null,
              }),
              abortController.signal,
            );
            if (!ok) {
              break;
            }
          }
        }

        if (delta.finishReason !== undefined && delta.finishReason !== null) {
          sawTerminalFinishReason = delta.finishReason;
        }
      }

      if (!abortController.signal.aborted && !res.writableEnded && !res.destroyed) {
        ensureSseHeadersSent();
        const tailSafeChunk = redactor.flush();
        if (tailSafeChunk.length > 0) {
          await writeSseWithBackpressure(
            res,
            encodeCompletionChunkSse({
              id: streamId,
              created: streamCreated,
              model: streamModel,
              ...(streamFingerprint !== undefined ? { systemFingerprint: streamFingerprint } : {}),
              contentDelta: tailSafeChunk,
              finishReason: null,
            }),
            abortController.signal,
          );
        }

        await writeSseWithBackpressure(
          res,
          encodeCompletionChunkSse({
            id: streamId,
            created: streamCreated,
            model: streamModel,
            ...(streamFingerprint !== undefined ? { systemFingerprint: streamFingerprint } : {}),
            finishReason: sawTerminalFinishReason ?? 'stop',
          }),
          abortController.signal,
        );

        await writeSseWithBackpressure(res, encodeSseDone(), abortController.signal);
      }

      streamFinished = true;
      const stats = redactor.getStats();
      logEvent('info', 'stream.completed', requestId, {
        redactionCount: stats.redactionCount,
        peakBufferedChars: stats.peakBufferedChars,
      });
    } catch (err) {
      streamFinished = true;
      logEvent('error', 'stream.upstream_error', requestId, {
        kind: err instanceof UpstreamStreamProviderError ? err.kind : 'UNKNOWN',
      });
      if (!abortController.signal.aborted && !res.writableEnded && !res.destroyed) {
        if (!res.headersSent) {
          if (err instanceof UpstreamStreamProviderError && err.kind === 'TIMEOUT') {
            writeJsonError(
              res,
              504,
              'UPSTREAM_TIMEOUT',
              'Upstream model provider timed out before responding.',
              requestId,
            );
          } else {
            writeJsonError(
              res,
              502,
              'UPSTREAM_UNAVAILABLE',
              'Upstream model provider is unavailable or returned an invalid response.',
              requestId,
            );
          }
          return;
        }

        const flushedBeforeError = redactor.flush();
        if (flushedBeforeError.length > 0) {
          res.write(
            encodeCompletionChunkSse({
              id: streamId,
              created: streamCreated,
              model: streamModel,
              ...(streamFingerprint !== undefined ? { systemFingerprint: streamFingerprint } : {}),
              contentDelta: flushedBeforeError,
              finishReason: null,
            }),
          );
        }
        res.write(
          encodeSseErrorEvent(
            'UPSTREAM_STREAM_ERROR',
            'Upstream model provider stream terminated unexpectedly.',
            requestId,
          ),
        );
        res.write(encodeSseDone());
      }
    } finally {
      req.removeListener('aborted', onClientDisconnect);
      res.removeListener('close', onClientDisconnect);
      if (!res.writableEnded && !res.destroyed) {
        res.end();
      }
    }
  };

  const server = createServer((req, res) => {
    const requestId = `req_${randomUUID()}`;
    const urlPath = (req.url ?? '/').split('?')[0];

    if (req.method === 'GET' && urlPath === '/health') {
      const payload = JSON.stringify({
        status: 'ok',
        service: 'llm-streaming-guardrail',
        provider: provider.providerName,
      });
      res.writeHead(200, {
        'content-type': 'application/json; charset=utf-8',
        'content-length': Buffer.byteLength(payload),
        'x-request-id': requestId,
      });
      res.end(payload);
      return;
    }

    if (urlPath !== '/v1/chat/completions') {
      writeJsonError(
        res,
        404,
        'NOT_FOUND',
        'Endpoint not found. Use POST /v1/chat/completions.',
        requestId,
      );
      return;
    }

    if (req.method !== 'POST') {
      writeJsonError(
        res,
        405,
        'METHOD_NOT_ALLOWED',
        'Only POST is supported on /v1/chat/completions.',
        requestId,
        { allow: 'POST' },
      );
      return;
    }

    void handleChatCompletions(req, res, requestId).catch(() => {
      if (!res.headersSent) {
        writeJsonError(res, 500, 'INTERNAL_ERROR', 'Internal gateway error.', requestId);
      } else if (!res.writableEnded) {
        res.end();
      }
    });
  });

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
