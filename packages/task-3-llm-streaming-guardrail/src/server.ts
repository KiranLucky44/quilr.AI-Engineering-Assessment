import { randomUUID } from 'node:crypto';
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';
import { validateChatCompletionRequest } from './middleware/request-validator.js';
import type { LLMStreamProvider } from './providers/llm-provider.interface.js';
import { MockLLMProvider } from './providers/mock-llm.provider.js';
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

function isJsonContentType(headerValue: string | undefined): boolean {
  if (!headerValue) {
    return false;
  }
  const mediaType = headerValue.split(';')[0]?.trim().toLowerCase();
  return mediaType === 'application/json';
}

function readBoundedBody(req: IncomingMessage, maxBytes: number): Promise<string> {
  return new Promise((resolvePromise, rejectPromise) => {
    const declared = req.headers['content-length'];
    if (declared !== undefined) {
      const parsedLength = Number.parseInt(declared, 10);
      if (Number.isFinite(parsedLength) && parsedLength > maxBytes) {
        req.resume();
        rejectPromise(new PayloadTooLargeError());
        return;
      }
    }

    const chunks: Buffer[] = [];
    let total = 0;
    let settled = false;

    req.on('data', (chunk: Buffer) => {
      if (settled) {
        return;
      }
      total += chunk.length;
      if (total > maxBytes) {
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
    if (!isJsonContentType(req.headers['content-type'])) {
      writeJsonError(
        res,
        415,
        'UNSUPPORTED_MEDIA_TYPE',
        'Content-Type must be application/json.',
        requestId,
      );
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
      writeJsonError(res, 400, 'INVALID_REQUEST', 'Failed to read request body.', requestId);
      return;
    }

    const validation = validateChatCompletionRequest(rawBody);
    if (!validation.valid) {
      writeJsonError(res, 400, 'INVALID_REQUEST', validation.message, requestId);
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

    res.writeHead(200, {
      'content-type': 'text/event-stream; charset=utf-8',
      'cache-control': 'no-cache, no-transform',
      connection: 'keep-alive',
      'x-accel-buffering': 'no',
      'x-request-id': requestId,
    });
    res.flushHeaders();

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
    } catch {
      streamFinished = true;
      logEvent('error', 'stream.upstream_error', requestId);
      if (!abortController.signal.aborted && !res.writableEnded && !res.destroyed) {
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
