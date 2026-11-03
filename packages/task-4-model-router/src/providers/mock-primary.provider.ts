import { ProviderHttpError } from '../errors/gateway-errors.js';
import type {
  ModelCompletionRequest,
  ModelCompletionResult,
  ModelProvider,
} from './model-provider.interface.js';

export interface MockPrimaryProviderOptions {
  readonly simulatedLatencyMs?: number;
  readonly timeoutScenarioLatencyMs?: number;
  readonly omitUsageReport?: boolean;
}

function waitWithAbort(delayMs: number, signal: AbortSignal, onCancel: () => void): Promise<void> {
  if (signal.aborted) {
    onCancel();
    return Promise.reject(new DOMException('Primary provider aborted', 'AbortError'));
  }
  if (delayMs <= 0) {
    return Promise.resolve();
  }

  return new Promise((resolvePromise, rejectPromise) => {
    const timer = setTimeout(() => {
      signal.removeEventListener('abort', handleAbort);
      resolvePromise();
    }, delayMs);

    const handleAbort = (): void => {
      clearTimeout(timer);
      onCancel();
      rejectPromise(new DOMException('Primary provider aborted', 'AbortError'));
    };

    signal.addEventListener('abort', handleAbort, { once: true });
  });
}

/**
 * Deterministic Primary Model Provider adapter (`MockPrimaryProvider`).
 * Supports deterministic simulation of HTTP 200, HTTP 429, >3000ms timeouts, and HTTP 500.
 */
export class MockPrimaryProvider implements ModelProvider {
  public readonly providerName = 'mock-primary';
  private readonly simulatedLatencyMs: number;
  private readonly timeoutScenarioLatencyMs: number;
  private readonly omitUsageReport: boolean;

  public invocationCount = 0;
  public cancelledCount = 0;

  public constructor(options: MockPrimaryProviderOptions = {}) {
    this.simulatedLatencyMs = options.simulatedLatencyMs ?? 0;
    this.timeoutScenarioLatencyMs = options.timeoutScenarioLatencyMs ?? 5_000;
    this.omitUsageReport = options.omitUsageReport ?? false;
  }

  public async generateCompletion(
    request: ModelCompletionRequest,
    signal: AbortSignal,
  ): Promise<ModelCompletionResult> {
    this.invocationCount += 1;
    const scenario = request.scenario ?? 'success';

    if (scenario === 'primary_timeout') {
      await waitWithAbort(this.timeoutScenarioLatencyMs, signal, () => {
        this.cancelledCount += 1;
      });
    }

    if (scenario === 'both_unavailable') {
      throw new ProviderHttpError(
        this.providerName,
        429,
        'Upstream rate limit on primary cluster node primary-internal-01.corp:8443',
      );
    }

    if (this.simulatedLatencyMs > 0) {
      await waitWithAbort(this.simulatedLatencyMs, signal, () => {
        this.cancelledCount += 1;
      });
    }

    if (scenario === 'primary_429' || scenario === 'secondary_unavailable') {
      throw new ProviderHttpError(
        this.providerName,
        429,
        'Primary model capacity exhausted (HTTP 429) on host 10.24.0.9',
      );
    }

    if (scenario === 'primary_500') {
      throw new ProviderHttpError(
        this.providerName,
        500,
        'Unhandled CUDA RuntimeError at /opt/inference/engine.cpp:412',
      );
    }

    const lastUserMessage =
      [...request.messages].reverse().find((m) => m.role === 'user')?.content ?? '';
    const content = `Primary model response (${request.model}): processed "${lastUserMessage.slice(0, 60)}"`;

    return {
      id: `chatcmpl_primary_${request.requestId}`,
      providerName: this.providerName,
      model: request.model,
      created: 1769904000,
      content,
      finishReason: 'stop',
      ...(this.omitUsageReport
        ? {}
        : {
            usage: {
              promptTokens: Math.max(4, request.messages.length * 6),
              completionTokens: 16,
              totalTokens: Math.max(4, request.messages.length * 6) + 16,
            },
          }),
    };
  }
}
