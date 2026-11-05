import type {
  ChatCompletionStreamRequest,
  LLMStreamProvider,
  NormalizedCompletionDelta,
} from './llm-provider.interface.js';
import { parseUpstreamSseEvents } from '../streaming/sse-encoder.js';

export const DEFAULT_OLLAMA_BASE_URL = 'http://127.0.0.1:11434/v1';
export const DEFAULT_OLLAMA_MODEL = 'llama3.2:1b';
export const DEFAULT_OLLAMA_TIMEOUT_MS = 30_000;

export type UpstreamErrorKind = 'TIMEOUT' | 'CONNECTION' | 'HTTP_STATUS' | 'MALFORMED_STREAM';

export class UpstreamStreamProviderError extends Error {
  public readonly kind: UpstreamErrorKind;
  public readonly statusCode: number | undefined;

  public constructor(kind: UpstreamErrorKind, publicSafeDetail: string, statusCode?: number) {
    super(publicSafeDetail);
    this.name = 'UpstreamStreamProviderError';
    this.kind = kind;
    this.statusCode = statusCode;
  }
}

export interface OllamaProviderOptions {
  readonly baseUrl?: string;
  readonly defaultModel?: string;
  readonly apiKey?: string;
  readonly timeoutMs?: number;
  readonly fetchImpl?: typeof fetch;
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isSignalAborted(sig: AbortSignal): boolean {
  return sig.aborted;
}

function normalizeBaseUrl(rawUrl: string): string {
  const trimmed = rawUrl.trim().replace(/\/+$/, '');
  let parsed: URL;
  try {
    parsed = new URL(trimmed);
  } catch {
    throw new Error('OLLAMA_BASE_URL must be a valid HTTP or HTTPS URL.');
  }
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
    throw new Error('OLLAMA_BASE_URL must use http: or https: protocol.');
  }
  return trimmed;
}

/**
 * Parses a single JSON payload from an OpenAI-compatible / Ollama SSE `data:` frame
 * into a `NormalizedCompletionDelta`.
 */
export function parseOpenAICompatibleChunkJson(
  rawJson: string,
  fallbackModel: string,
): NormalizedCompletionDelta | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(rawJson);
  } catch {
    throw new UpstreamStreamProviderError(
      'MALFORMED_STREAM',
      'Upstream provider emitted invalid JSON in SSE stream.',
    );
  }

  if (!isPlainObject(parsed)) {
    throw new UpstreamStreamProviderError(
      'MALFORMED_STREAM',
      'Upstream provider SSE payload must be a JSON object.',
    );
  }

  if ('error' in parsed && parsed['error'] !== undefined && parsed['error'] !== null) {
    throw new UpstreamStreamProviderError(
      'MALFORMED_STREAM',
      'Upstream provider reported a mid-stream error.',
    );
  }

  const choices = parsed['choices'];
  if (!Array.isArray(choices)) {
    throw new UpstreamStreamProviderError(
      'MALFORMED_STREAM',
      'Upstream provider SSE chunk is missing choices array.',
    );
  }

  if (choices.length === 0) {
    return null;
  }

  const firstChoice: unknown = choices[0];
  if (!isPlainObject(firstChoice)) {
    throw new UpstreamStreamProviderError(
      'MALFORMED_STREAM',
      'Upstream provider SSE choice entry is malformed.',
    );
  }

  const deltaRaw = firstChoice['delta'];
  if (deltaRaw !== undefined && !isPlainObject(deltaRaw)) {
    throw new UpstreamStreamProviderError(
      'MALFORMED_STREAM',
      'Upstream provider SSE delta field must be an object.',
    );
  }

  const id =
    typeof parsed['id'] === 'string' && parsed['id'].length > 0 ? parsed['id'] : 'chatcmpl_ollama';
  const created =
    typeof parsed['created'] === 'number' && Number.isFinite(parsed['created'])
      ? parsed['created']
      : Math.floor(Date.now() / 1000);
  const model =
    typeof parsed['model'] === 'string' && parsed['model'].length > 0
      ? parsed['model']
      : fallbackModel;
  const systemFingerprint =
    typeof parsed['system_fingerprint'] === 'string' && parsed['system_fingerprint'].length > 0
      ? parsed['system_fingerprint']
      : undefined;

  const role = deltaRaw?.['role'] === 'assistant' ? 'assistant' : undefined;
  const contentValue = deltaRaw?.['content'];
  if (contentValue !== undefined && contentValue !== null && typeof contentValue !== 'string') {
    throw new UpstreamStreamProviderError(
      'MALFORMED_STREAM',
      'Upstream provider SSE delta.content must be a string or null.',
    );
  }
  const contentDelta = typeof contentValue === 'string' ? contentValue : undefined;

  const rawFinish = firstChoice['finish_reason'];
  let finishReason: 'stop' | 'length' | null = null;
  if (rawFinish === 'length') {
    finishReason = 'length';
  } else if (typeof rawFinish === 'string' && rawFinish.length > 0) {
    finishReason = 'stop';
  }

  return {
    id,
    created,
    model,
    ...(systemFingerprint !== undefined ? { systemFingerprint } : {}),
    ...(role !== undefined ? { role } : {}),
    ...(contentDelta !== undefined ? { contentDelta } : {}),
    finishReason,
  };
}

async function* readableStreamToAsyncIterable(
  stream: ReadableStream<Uint8Array>,
  onActivity: () => void,
): AsyncGenerator<Uint8Array> {
  const reader = stream.getReader();
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) {
        return;
      }
      onActivity();
      yield value;
    }
  } finally {
    reader.releaseLock();
  }
}

/**
 * Real streaming LLM provider targeting Ollama's OpenAI-compatible
 * `POST /v1/chat/completions` SSE endpoint.
 */
export class OllamaProvider implements LLMStreamProvider {
  public readonly providerName = 'ollama';
  private readonly baseUrl: string;
  private readonly defaultModel: string;
  private readonly apiKey: string | undefined;
  private readonly timeoutMs: number;
  private readonly fetchImpl: typeof fetch;

  public constructor(options: OllamaProviderOptions = {}) {
    this.baseUrl = normalizeBaseUrl(options.baseUrl ?? DEFAULT_OLLAMA_BASE_URL);
    this.defaultModel = options.defaultModel?.trim() || DEFAULT_OLLAMA_MODEL;
    this.apiKey =
      options.apiKey && options.apiKey.trim().length > 0 ? options.apiKey.trim() : undefined;
    this.timeoutMs =
      options.timeoutMs !== undefined && Number.isFinite(options.timeoutMs) && options.timeoutMs > 0
        ? options.timeoutMs
        : DEFAULT_OLLAMA_TIMEOUT_MS;
    this.fetchImpl = options.fetchImpl ?? fetch;
  }

  public resolveModel(requestedModel: string): string {
    const trimmed = requestedModel.trim();
    if (
      trimmed.length === 0 ||
      trimmed === 'default' ||
      trimmed === 'ollama' ||
      trimmed === 'quill-mock-gpt'
    ) {
      return this.defaultModel;
    }
    return trimmed;
  }

  public async *streamChatCompletion(
    request: ChatCompletionStreamRequest,
    signal: AbortSignal,
  ): AsyncGenerator<NormalizedCompletionDelta> {
    if (signal.aborted) {
      return;
    }

    const targetModel = this.resolveModel(request.model);
    const upstreamController = new AbortController();
    const timeoutState = { timedOut: false };
    let idleTimer: ReturnType<typeof setTimeout> | null = null;

    const resetTimeout = (): void => {
      if (idleTimer !== null) {
        clearTimeout(idleTimer);
      }
      idleTimer = setTimeout(() => {
        timeoutState.timedOut = true;
        upstreamController.abort();
      }, this.timeoutMs);
    };

    const clearTimer = (): void => {
      if (idleTimer !== null) {
        clearTimeout(idleTimer);
        idleTimer = null;
      }
    };

    const onCallerAbort = (): void => {
      clearTimer();
      upstreamController.abort();
    };

    signal.addEventListener('abort', onCallerAbort, { once: true });
    resetTimeout();

    const headers: Record<string, string> = {
      'content-type': 'application/json',
      accept: 'text/event-stream',
    };
    if (this.apiKey !== undefined) {
      headers['authorization'] = `Bearer ${this.apiKey}`;
    }

    const upstreamPayload = {
      model: targetModel,
      stream: true,
      messages: request.messages.map((m) => ({
        role: m.role,
        content: m.content,
      })),
      ...(request.temperature !== undefined ? { temperature: request.temperature } : {}),
      ...(request.max_tokens !== undefined ? { max_tokens: request.max_tokens } : {}),
    };

    let response: Response;
    try {
      response = await this.fetchImpl(`${this.baseUrl}/chat/completions`, {
        method: 'POST',
        headers,
        body: JSON.stringify(upstreamPayload),
        signal: upstreamController.signal,
      });
    } catch (err) {
      clearTimer();
      signal.removeEventListener('abort', onCallerAbort);
      if (isSignalAborted(signal)) {
        return;
      }
      if (timeoutState.timedOut) {
        throw new UpstreamStreamProviderError(
          'TIMEOUT',
          'Upstream LLM provider timed out before responding.',
        );
      }
      throw new UpstreamStreamProviderError(
        'CONNECTION',
        err instanceof Error && err.name === 'AbortError'
          ? 'Upstream LLM provider request was aborted.'
          : 'Failed to connect to upstream LLM provider.',
      );
    }

    try {
      if (!response.ok) {
        await response.body?.cancel().catch(() => undefined);
        throw new UpstreamStreamProviderError(
          'HTTP_STATUS',
          `Upstream LLM provider returned HTTP ${response.status}.`,
          response.status,
        );
      }

      if (!response.body) {
        throw new UpstreamStreamProviderError(
          'MALFORMED_STREAM',
          'Upstream LLM provider response did not include a readable stream body.',
        );
      }

      let emittedAssistantRole = false;
      const byteChunks = readableStreamToAsyncIterable(response.body, resetTimeout);

      for await (const rawEventJson of parseUpstreamSseEvents(
        byteChunks,
        upstreamController.signal,
      )) {
        if (isSignalAborted(signal)) {
          return;
        }
        resetTimeout();

        const normalized = parseOpenAICompatibleChunkJson(rawEventJson, targetModel);
        if (!normalized) {
          continue;
        }

        const shouldIncludeRole = normalized.role === 'assistant' && !emittedAssistantRole;
        if (shouldIncludeRole) {
          emittedAssistantRole = true;
        }

        const sanitizedDelta: NormalizedCompletionDelta = {
          id: normalized.id,
          created: normalized.created,
          model: normalized.model,
          ...(normalized.systemFingerprint !== undefined
            ? { systemFingerprint: normalized.systemFingerprint }
            : {}),
          ...(shouldIncludeRole ? { role: 'assistant' } : {}),
          ...(normalized.contentDelta !== undefined
            ? { contentDelta: normalized.contentDelta }
            : {}),
          ...(normalized.finishReason !== undefined
            ? { finishReason: normalized.finishReason }
            : {}),
        };

        // Skip redundant empty non-terminal deltas when role has already been emitted
        if (
          sanitizedDelta.role === undefined &&
          (sanitizedDelta.contentDelta === undefined || sanitizedDelta.contentDelta.length === 0) &&
          (sanitizedDelta.finishReason === undefined || sanitizedDelta.finishReason === null)
        ) {
          continue;
        }

        yield sanitizedDelta;
      }
    } catch (err) {
      if (isSignalAborted(signal)) {
        return;
      }
      if (timeoutState.timedOut) {
        throw new UpstreamStreamProviderError(
          'TIMEOUT',
          'Upstream LLM provider timed out while streaming tokens.',
        );
      }
      if (err instanceof UpstreamStreamProviderError) {
        throw err;
      }
      throw new UpstreamStreamProviderError(
        'MALFORMED_STREAM',
        'Upstream LLM provider stream terminated with an invalid SSE frame.',
      );
    } finally {
      clearTimer();
      signal.removeEventListener('abort', onCallerAbort);
    }
  }
}
