import {
  ProviderConnectionError,
  ProviderHttpError,
  ProviderMalformedResponseError,
  ProviderTimeoutError,
} from '../errors/gateway-errors.js';
import type {
  ModelCompletionRequest,
  ModelCompletionResult,
  ModelProvider,
  ProviderTokenUsage,
} from './model-provider.interface.js';

export const DEFAULT_OLLAMA_BASE_URL = 'http://127.0.0.1:11434/v1';
export const DEFAULT_OLLAMA_MODEL = 'llama3.2:1b';

export interface OpenAICompatibleProviderOptions {
  readonly providerName?: string;
  readonly baseUrl?: string;
  readonly configuredModel?: string;
  readonly apiKey?: string;
  readonly authHeaderName?: string;
  readonly authHeaderValue?: string;
  readonly timeoutMs?: number;
  readonly fetchImpl?: typeof fetch;
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isSignalAborted(sig: AbortSignal): boolean {
  return sig.aborted;
}

function normalizeHttpBaseUrl(rawUrl: string): string {
  const trimmed = rawUrl.trim().replace(/\/+$/, '');
  let parsed: URL;
  try {
    parsed = new URL(trimmed);
  } catch {
    throw new Error('Provider base URL must be a valid HTTP or HTTPS URL.');
  }
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
    throw new Error('Provider base URL must use http: or https: protocol.');
  }
  return trimmed;
}

function extractUsage(rawUsage: unknown): ProviderTokenUsage | undefined {
  if (!isPlainObject(rawUsage)) {
    return undefined;
  }
  const promptTokens = rawUsage['prompt_tokens'];
  const completionTokens = rawUsage['completion_tokens'];
  const totalTokens = rawUsage['total_tokens'];

  if (
    typeof promptTokens === 'number' &&
    Number.isFinite(promptTokens) &&
    promptTokens >= 0 &&
    typeof completionTokens === 'number' &&
    Number.isFinite(completionTokens) &&
    completionTokens >= 0
  ) {
    const resolvedTotal =
      typeof totalTokens === 'number' && Number.isFinite(totalTokens) && totalTokens >= 0
        ? Math.trunc(totalTokens)
        : Math.trunc(promptTokens) + Math.trunc(completionTokens);
    return {
      promptTokens: Math.trunc(promptTokens),
      completionTokens: Math.trunc(completionTokens),
      totalTokens: resolvedTotal,
    };
  }

  return undefined;
}

/**
 * Validates and normalizes an OpenAI-compatible non-streaming `/chat/completions` JSON body.
 */
export function parseOpenAIChatCompletionJson(
  rawBody: string,
  providerName: string,
  fallbackModel: string,
  requestId: string,
): ModelCompletionResult {
  let parsed: unknown;
  try {
    parsed = JSON.parse(rawBody);
  } catch {
    throw new ProviderMalformedResponseError(
      providerName,
      'Upstream provider returned malformed JSON.',
    );
  }

  if (!isPlainObject(parsed)) {
    throw new ProviderMalformedResponseError(
      providerName,
      'Upstream provider response must be a JSON object.',
    );
  }

  const choices = parsed['choices'];
  if (!Array.isArray(choices) || choices.length === 0) {
    throw new ProviderMalformedResponseError(
      providerName,
      'Upstream provider response is missing choices array.',
    );
  }

  const firstChoice: unknown = choices[0];
  if (!isPlainObject(firstChoice)) {
    throw new ProviderMalformedResponseError(
      providerName,
      'Upstream provider choice entry is malformed.',
    );
  }

  const message = firstChoice['message'];
  if (!isPlainObject(message) || typeof message['content'] !== 'string') {
    throw new ProviderMalformedResponseError(
      providerName,
      'Upstream provider choice is missing assistant message content.',
    );
  }

  const id =
    typeof parsed['id'] === 'string' && parsed['id'].length > 0
      ? parsed['id']
      : `chatcmpl_${requestId}`;
  const model =
    typeof parsed['model'] === 'string' && parsed['model'].length > 0
      ? parsed['model']
      : fallbackModel;
  const created =
    typeof parsed['created'] === 'number' && Number.isFinite(parsed['created'])
      ? parsed['created']
      : Math.floor(Date.now() / 1000);
  const finishReason: 'stop' | 'length' =
    firstChoice['finish_reason'] === 'length' ? 'length' : 'stop';
  const usage = extractUsage(parsed['usage']);

  return {
    id,
    providerName,
    model,
    created,
    content: message['content'],
    finishReason,
    ...(usage !== undefined ? { usage } : {}),
  };
}

/**
 * Configurable HTTP ModelProvider adapter for OpenAI-compatible inference servers
 * (including local Ollama `/v1/chat/completions`, vLLM, llama.cpp, or OpenAI).
 */
export class OpenAICompatibleModelProvider implements ModelProvider {
  public readonly providerName: string;
  private readonly baseUrl: string;
  private readonly configuredModel: string | undefined;
  private readonly apiKey: string | undefined;
  private readonly authHeaderName: string | undefined;
  private readonly authHeaderValue: string | undefined;
  private readonly timeoutMs: number | undefined;
  private readonly fetchImpl: typeof fetch;

  public invocationCount = 0;
  public cancelledCount = 0;

  public constructor(options: OpenAICompatibleProviderOptions = {}) {
    this.providerName = options.providerName?.trim() || 'openai-compatible';
    this.baseUrl = normalizeHttpBaseUrl(options.baseUrl ?? DEFAULT_OLLAMA_BASE_URL);
    this.configuredModel =
      options.configuredModel && options.configuredModel.trim().length > 0
        ? options.configuredModel.trim()
        : undefined;
    this.apiKey =
      options.apiKey && options.apiKey.trim().length > 0 ? options.apiKey.trim() : undefined;
    this.authHeaderName =
      options.authHeaderName && options.authHeaderName.trim().length > 0
        ? options.authHeaderName.trim()
        : undefined;
    this.authHeaderValue =
      options.authHeaderValue && options.authHeaderValue.trim().length > 0
        ? options.authHeaderValue.trim()
        : undefined;
    this.timeoutMs =
      options.timeoutMs !== undefined && Number.isFinite(options.timeoutMs) && options.timeoutMs > 0
        ? options.timeoutMs
        : undefined;
    this.fetchImpl = options.fetchImpl ?? fetch;
  }

  public resolveModel(requestedModel: string): string {
    if (this.configuredModel !== undefined) {
      return this.configuredModel;
    }
    const trimmed = requestedModel.trim();
    return trimmed.length > 0 ? trimmed : DEFAULT_OLLAMA_MODEL;
  }

  public async generateCompletion(
    request: ModelCompletionRequest,
    signal: AbortSignal,
  ): Promise<ModelCompletionResult> {
    this.invocationCount += 1;

    if (signal.aborted) {
      this.cancelledCount += 1;
      throw new DOMException(`Provider ${this.providerName} aborted`, 'AbortError');
    }

    const targetModel = this.resolveModel(request.model);
    const requestController = new AbortController();
    const timeoutState = { triggered: false };
    let timer: ReturnType<typeof setTimeout> | null = null;

    const onCallerAbort = (): void => {
      this.cancelledCount += 1;
      if (timer !== null) {
        clearTimeout(timer);
        timer = null;
      }
      requestController.abort();
    };

    signal.addEventListener('abort', onCallerAbort, { once: true });

    if (this.timeoutMs !== undefined) {
      timer = setTimeout(() => {
        timeoutState.triggered = true;
        requestController.abort();
      }, this.timeoutMs);
    }

    const headers: Record<string, string> = {
      'content-type': 'application/json',
      accept: 'application/json',
    };
    if (this.apiKey !== undefined) {
      headers['authorization'] = `Bearer ${this.apiKey}`;
    } else if (this.authHeaderName !== undefined && this.authHeaderValue !== undefined) {
      headers[this.authHeaderName.toLowerCase()] = this.authHeaderValue;
    }

    const payload = {
      model: targetModel,
      stream: false,
      messages: request.messages.map((m) => ({
        role: m.role,
        content: m.content,
      })),
      max_tokens: request.maxTokens,
      ...(request.temperature !== undefined ? { temperature: request.temperature } : {}),
    };

    try {
      let response: Response;
      try {
        response = await this.fetchImpl(`${this.baseUrl}/chat/completions`, {
          method: 'POST',
          headers,
          body: JSON.stringify(payload),
          signal: requestController.signal,
        });
      } catch (err) {
        if (timeoutState.triggered && this.timeoutMs !== undefined) {
          throw new ProviderTimeoutError(this.providerName, this.timeoutMs);
        }
        if (isSignalAborted(signal) || (err instanceof Error && err.name === 'AbortError')) {
          throw new DOMException(`Provider ${this.providerName} aborted`, 'AbortError');
        }
        throw new ProviderConnectionError(
          this.providerName,
          `Upstream connection to ${this.providerName} failed.`,
        );
      }

      if (!response.ok) {
        await response.body?.cancel().catch(() => undefined);
        throw new ProviderHttpError(
          this.providerName,
          response.status,
          `Upstream provider ${this.providerName} returned HTTP ${response.status}.`,
        );
      }

      let rawBody: string;
      try {
        rawBody = await response.text();
      } catch (err) {
        if (timeoutState.triggered && this.timeoutMs !== undefined) {
          throw new ProviderTimeoutError(this.providerName, this.timeoutMs);
        }
        if (isSignalAborted(signal) || (err instanceof Error && err.name === 'AbortError')) {
          throw new DOMException(`Provider ${this.providerName} aborted`, 'AbortError');
        }
        throw new ProviderConnectionError(
          this.providerName,
          `Failed reading response body from ${this.providerName}.`,
        );
      }

      return parseOpenAIChatCompletionJson(
        rawBody,
        this.providerName,
        targetModel,
        request.requestId,
      );
    } finally {
      if (timer !== null) {
        clearTimeout(timer);
      }
      signal.removeEventListener('abort', onCallerAbort);
    }
  }
}
