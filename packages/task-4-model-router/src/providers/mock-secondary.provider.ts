import { ProviderHttpError } from '../errors/gateway-errors.js';
import type {
  ModelCompletionRequest,
  ModelCompletionResult,
  ModelProvider,
} from './model-provider.interface.js';

export interface MockSecondaryProviderOptions {
  readonly simulatedLatencyMs?: number;
}

function waitWithAbort(delayMs: number, signal: AbortSignal, onCancel: () => void): Promise<void> {
  if (signal.aborted) {
    onCancel();
    return Promise.reject(new DOMException('Secondary provider aborted', 'AbortError'));
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
      rejectPromise(new DOMException('Secondary provider aborted', 'AbortError'));
    };

    signal.addEventListener('abort', handleAbort, { once: true });
  });
}

/**
 * Deterministic Secondary Failover Model Provider adapter (`MockSecondaryProvider`).
 */
export class MockSecondaryProvider implements ModelProvider {
  public readonly providerName = 'mock-secondary';
  private readonly simulatedLatencyMs: number;

  public invocationCount = 0;
  public cancelledCount = 0;

  public constructor(options: MockSecondaryProviderOptions = {}) {
    this.simulatedLatencyMs = options.simulatedLatencyMs ?? 0;
  }

  public async generateCompletion(
    request: ModelCompletionRequest,
    signal: AbortSignal,
  ): Promise<ModelCompletionResult> {
    this.invocationCount += 1;

    if (this.simulatedLatencyMs > 0) {
      await waitWithAbort(this.simulatedLatencyMs, signal, () => {
        this.cancelledCount += 1;
      });
    }

    const scenario = request.scenario ?? 'success';
    if (scenario === 'secondary_unavailable' || scenario === 'both_unavailable') {
      throw new ProviderHttpError(
        this.providerName,
        503,
        'Secondary failover cluster unavailable on backup-node-03.internal:9443',
      );
    }

    const lastUserMessage =
      [...request.messages].reverse().find((m) => m.role === 'user')?.content ?? '';
    const content = `Secondary failover model response (${request.model}-fallback): processed "${lastUserMessage.slice(0, 60)}"`;

    return {
      id: `chatcmpl_secondary_${request.requestId}`,
      providerName: this.providerName,
      model: `${request.model}-fallback`,
      created: 1769904000,
      content,
      finishReason: 'stop',
      usage: {
        promptTokens: Math.max(4, request.messages.length * 6),
        completionTokens: 18,
        totalTokens: Math.max(4, request.messages.length * 6) + 18,
      },
    };
  }
}
