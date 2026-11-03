import { randomUUID } from 'node:crypto';
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';
import { z } from 'zod';
import type { DemoScenario } from './config.js';
import { GatewayError, type StandardizedErrorPayload } from './errors/gateway-errors.js';
import type { ModelRouter } from './router/model-router.js';

export interface ModelRouterServerOptions {
  readonly router: ModelRouter;
  readonly maxBodyBytes?: number;
  readonly defaultScenario?: DemoScenario;
  readonly silentLogs?: boolean;
}

export interface ModelRouterServerHandle {
  readonly server: Server;
  listen(port: number, host?: string): Promise<number>;
  close(): Promise<void>;
}

const RouterChatMessageSchema = z
  .object({
    role: z.enum(['system', 'user', 'assistant']),
    content: z.string().min(1, 'message content must be a non-empty string'),
  })
  .strict();

const RouterRequestSchema = z
  .object({
    model: z.string().trim().min(1, 'model must be a non-empty string'),
    messages: z
      .array(RouterChatMessageSchema)
      .min(1, 'messages must contain at least one chat message'),
    max_tokens: z.number().int().positive().max(32768).optional(),
    temperature: z.number().finite().min(0).max(2).optional(),
    stream: z.literal(false).optional(),
    mock_scenario: z
      .enum([
        'success',
        'primary_429',
        'primary_timeout',
        'primary_500',
        'secondary_unavailable',
        'both_unavailable',
      ])
      .optional(),
  })
  .strict();

class PayloadTooLargeError extends Error {
  public constructor() {
    super('Payload too large');
    this.name = 'PayloadTooLargeError';
  }
}

function extractBearerApiKey(headerValue: string | undefined): string | null {
  if (!headerValue || headerValue.trim().length === 0) {
    return null;
  }
  const parts = headerValue.trim().split(' ');
  if (parts.length !== 2) {
    return null;
  }
  const [scheme, key] = parts;
  if (!scheme || scheme.toLowerCase() !== 'bearer' || !key || key.trim().length === 0) {
    return null;
  }
  return key.trim();
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
      const length = Number.parseInt(declared, 10);
      if (Number.isFinite(length) && length > maxBytes) {
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

function writeJsonResponse(
  res: ServerResponse,
  statusCode: number,
  requestId: string,
  payload: unknown,
  extraHeaders?: Record<string, string>,
): void {
  const body = JSON.stringify(payload);
  res.writeHead(statusCode, {
    'content-type': 'application/json; charset=utf-8',
    'content-length': Buffer.byteLength(body),
    'cache-control': 'no-store',
    'x-request-id': requestId,
    ...extraHeaders,
  });
  res.end(body);
}

/**
 * Creates the Task 4 HTTP LLM Gateway with SQLite sliding-window token rate limiting
 * and selective primary -> secondary model failover.
 */
export function createModelRouterServer(
  options: ModelRouterServerOptions,
): ModelRouterServerHandle {
  const maxBodyBytes = options.maxBodyBytes ?? 131_072;
  const defaultScenario = options.defaultScenario ?? 'success';
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
        component: 'task-4-model-router',
        event,
        requestId,
        ...(meta ? { meta } : {}),
      })}\n`,
    );
  };

  const writeGatewayError = (
    res: ServerResponse,
    err: GatewayError,
    requestId: string,
    extraHeaders?: Record<string, string>,
  ): void => {
    const headers: Record<string, string> = { ...extraHeaders };
    if (err.code === 'RATE_LIMIT_EXCEEDED' && err.retryAfterMs !== undefined) {
      headers['retry-after'] = String(Math.max(1, Math.ceil(err.retryAfterMs / 1000)));
    }
    if (err.code === 'UNAUTHORIZED') {
      headers['www-authenticate'] = 'Bearer realm="quill-model-router"';
    }
    const payload: StandardizedErrorPayload = err.toResponsePayload(requestId);
    writeJsonResponse(res, err.httpStatus, requestId, payload, headers);
  };

  const handleChatCompletion = async (
    req: IncomingMessage,
    res: ServerResponse,
    requestId: string,
  ): Promise<void> => {
    const authHeader =
      typeof req.headers['authorization'] === 'string' ? req.headers['authorization'] : undefined;
    const apiKey = extractBearerApiKey(authHeader);

    if (!apiKey) {
      writeGatewayError(
        res,
        new GatewayError('UNAUTHORIZED', 401, 'Missing or malformed Authorization Bearer API key.'),
        requestId,
      );
      return;
    }

    if (!isJsonContentType(req.headers['content-type'])) {
      writeGatewayError(
        res,
        new GatewayError('INVALID_REQUEST', 415, 'Content-Type must be application/json.'),
        requestId,
      );
      return;
    }

    let rawBody: string;
    try {
      rawBody = await readBoundedBody(req, maxBodyBytes);
    } catch (err) {
      if (err instanceof PayloadTooLargeError) {
        writeGatewayError(
          res,
          new GatewayError(
            'INVALID_REQUEST',
            413,
            `Request body exceeds maximum size of ${maxBodyBytes} bytes.`,
          ),
          requestId,
        );
        return;
      }
      writeGatewayError(
        res,
        new GatewayError('INVALID_REQUEST', 400, 'Failed to read HTTP request body.'),
        requestId,
      );
      return;
    }

    let parsedJson: unknown;
    try {
      parsedJson = JSON.parse(rawBody);
    } catch {
      writeGatewayError(
        res,
        new GatewayError('INVALID_REQUEST', 400, 'Malformed JSON request body.'),
        requestId,
      );
      return;
    }

    const validated = RouterRequestSchema.safeParse(parsedJson);
    if (!validated.success) {
      const issueSummary = validated.error.issues
        .map((i) => `${i.path.length > 0 ? i.path.join('.') : 'body'}: ${i.message}`)
        .join('; ');
      writeGatewayError(
        res,
        new GatewayError('INVALID_REQUEST', 400, `Invalid request payload: ${issueSummary}`),
        requestId,
      );
      return;
    }

    const callerAbort = new AbortController();
    const onDisconnect = (): void => {
      if (!res.writableEnded) {
        callerAbort.abort();
      }
    };
    req.once('aborted', onDisconnect);
    res.once('close', onDisconnect);

    try {
      const outcome = await options.router.routeChatCompletion({
        requestId,
        tenantApiKey: apiKey,
        model: validated.data.model,
        messages: validated.data.messages,
        ...(validated.data.max_tokens !== undefined
          ? { maxTokens: validated.data.max_tokens }
          : {}),
        ...(validated.data.temperature !== undefined
          ? { temperature: validated.data.temperature }
          : {}),
        scenario: validated.data.mock_scenario ?? defaultScenario,
        callerSignal: callerAbort.signal,
      });

      logEvent('info', 'router.completed', requestId, {
        provider: outcome.completion.providerName,
        routedToFallback: outcome.routedToFallback,
        ...(outcome.fallbackReason ? { fallbackReason: outcome.fallbackReason } : {}),
        reservedTokens: outcome.reservedTokens,
        settledTokens: outcome.settledTokens,
      });

      writeJsonResponse(res, 200, requestId, {
        id: outcome.completion.id,
        object: 'chat.completion',
        created: outcome.completion.created,
        model: outcome.completion.model,
        request_id: requestId,
        provider: outcome.completion.providerName,
        routed_via_fallback: outcome.routedToFallback,
        choices: [
          {
            index: 0,
            message: {
              role: 'assistant',
              content: outcome.completion.content,
            },
            finish_reason: outcome.completion.finishReason,
          },
        ],
        usage: {
          prompt_tokens: outcome.completion.usage?.promptTokens ?? 0,
          completion_tokens: outcome.completion.usage?.completionTokens ?? 0,
          total_tokens: outcome.settledTokens,
        },
      });
    } catch (err) {
      if (err instanceof GatewayError) {
        logEvent('warn', 'router.gateway_error', requestId, {
          code: err.code,
          httpStatus: err.httpStatus,
        });
        writeGatewayError(res, err, requestId);
        return;
      }

      logEvent('error', 'router.unexpected_error', requestId);
      writeGatewayError(
        res,
        new GatewayError(
          'MODEL_UNAVAILABLE',
          503,
          'All model providers are currently unavailable.',
        ),
        requestId,
      );
    } finally {
      req.removeListener('aborted', onDisconnect);
      res.removeListener('close', onDisconnect);
    }
  };

  const server = createServer((req, res) => {
    const requestId = `req_${randomUUID()}`;
    const urlPath = (req.url ?? '/').split('?')[0];

    if (req.method === 'GET' && urlPath === '/health') {
      writeJsonResponse(res, 200, requestId, {
        status: 'ok',
        service: 'task-4-model-router',
        request_id: requestId,
      });
      return;
    }

    if (urlPath !== '/v1/chat/completions') {
      writeGatewayError(
        res,
        new GatewayError(
          'INVALID_REQUEST',
          404,
          'Endpoint not found. Use POST /v1/chat/completions.',
        ),
        requestId,
      );
      return;
    }

    if (req.method !== 'POST') {
      writeGatewayError(
        res,
        new GatewayError('INVALID_REQUEST', 405, 'Only POST is supported on /v1/chat/completions.'),
        requestId,
        { allow: 'POST' },
      );
      return;
    }

    void handleChatCompletion(req, res, requestId).catch(() => {
      if (!res.headersSent) {
        writeGatewayError(
          res,
          new GatewayError(
            'MODEL_UNAVAILABLE',
            503,
            'All model providers are currently unavailable.',
          ),
          requestId,
        );
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
