import type { DemoScenario } from '../config.js';
import { GatewayError, ProviderTimeoutError } from '../errors/gateway-errors.js';
import type { SlidingWindowLimiter } from '../limiter/sliding-window-limiter.js';
import type { TokenCounter } from '../limiter/token-counter.js';
import type {
  ModelCompletionRequest,
  ModelCompletionResult,
  ModelProvider,
  RouterChatMessage,
} from '../providers/model-provider.interface.js';
import { evaluateFallbackPolicy, type FallbackTriggerReason } from './fallback-policy.js';

export interface ModelRouterOptions {
  readonly primaryProvider: ModelProvider;
  readonly secondaryProvider: ModelProvider;
  readonly limiter: SlidingWindowLimiter;
  readonly tokenCounter: TokenCounter;
  readonly primaryTimeoutMs?: number;
  readonly secondaryTimeoutMs?: number;
  readonly defaultMaxTokens?: number;
  readonly windowMs?: number;
}

export interface RoutedCompletionInput {
  readonly requestId: string;
  readonly tenantApiKey: string;
  readonly model: string;
  readonly messages: readonly RouterChatMessage[];
  readonly maxTokens?: number;
  readonly temperature?: number;
  readonly scenario?: DemoScenario;
  readonly callerSignal?: AbortSignal;
}

export interface RoutedCompletionOutput {
  readonly completion: ModelCompletionResult;
  readonly routedToFallback: boolean;
  readonly fallbackReason?: FallbackTriggerReason;
  readonly reservedTokens: number;
  readonly settledTokens: number;
}

async function invokeProviderWithTimeout(
  provider: ModelProvider,
  request: ModelCompletionRequest,
  timeoutMs: number,
  callerSignal?: AbortSignal,
): Promise<ModelCompletionResult> {
  const controller = new AbortController();
  const timeoutState = { triggered: false };

  const onCallerAbort = (): void => {
    controller.abort();
  };

  if (callerSignal) {
    if (callerSignal.aborted) {
      controller.abort();
    } else {
      callerSignal.addEventListener('abort', onCallerAbort, { once: true });
    }
  }

  const timer = setTimeout(() => {
    timeoutState.triggered = true;
    controller.abort();
  }, timeoutMs);

  try {
    return await provider.generateCompletion(request, controller.signal);
  } catch (err) {
    if (timeoutState.triggered) {
      throw new ProviderTimeoutError(provider.providerName, timeoutMs);
    }
    throw err;
  } finally {
    clearTimeout(timer);
    if (callerSignal) {
      callerSignal.removeEventListener('abort', onCallerAbort);
    }
  }
}

/**
 * Coordinates atomic SQLite sliding-window token reservation, primary model invocation
 * with strict `AbortController` timeout cancellation, single-hop failover to secondary
 * on HTTP 429 or timeout, and post-generation token usage reconciliation.
 */
export class ModelRouter {
  private readonly primaryProvider: ModelProvider;
  private readonly secondaryProvider: ModelProvider;
  private readonly limiter: SlidingWindowLimiter;
  private readonly tokenCounter: TokenCounter;
  private readonly primaryTimeoutMs: number;
  private readonly secondaryTimeoutMs: number;
  private readonly defaultMaxTokens: number;
  private readonly windowMs: number;

  public constructor(options: ModelRouterOptions) {
    this.primaryProvider = options.primaryProvider;
    this.secondaryProvider = options.secondaryProvider;
    this.limiter = options.limiter;
    this.tokenCounter = options.tokenCounter;
    this.primaryTimeoutMs = options.primaryTimeoutMs ?? 3_000;
    this.secondaryTimeoutMs = options.secondaryTimeoutMs ?? 3_000;
    this.defaultMaxTokens = options.defaultMaxTokens ?? 256;
    this.windowMs = options.windowMs ?? 60_000;
  }

  public async routeChatCompletion(input: RoutedCompletionInput): Promise<RoutedCompletionOutput> {
    const estimate = this.tokenCounter.estimateReservation(
      input.messages,
      input.maxTokens,
      this.defaultMaxTokens,
    );

    const reservation = this.limiter.tryReserveTokens(
      input.tenantApiKey,
      input.requestId,
      estimate.reservedTokens,
    );

    if (!reservation.allowed) {
      const windowSeconds = Math.round(this.windowMs / 1000);
      throw new GatewayError(
        'RATE_LIMIT_EXCEEDED',
        429,
        `Tenant token quota of ${reservation.quotaLimit} tokens per rolling ${windowSeconds}s window exceeded.`,
        reservation.retryAfterMs,
      );
    }

    const providerRequest: ModelCompletionRequest = {
      requestId: input.requestId,
      model: input.model,
      messages: input.messages,
      maxTokens: estimate.completionBudget,
      ...(input.temperature !== undefined ? { temperature: input.temperature } : {}),
      ...(input.scenario !== undefined ? { scenario: input.scenario } : {}),
    };

    try {
      const primaryResult = await invokeProviderWithTimeout(
        this.primaryProvider,
        providerRequest,
        this.primaryTimeoutMs,
        input.callerSignal,
      );

      const settledTokens = this.tokenCounter.reconcileActualTokens(
        estimate.promptTokens,
        primaryResult.content,
        primaryResult.usage,
      );
      this.limiter.settleReservation(input.requestId, settledTokens);

      return {
        completion: primaryResult,
        routedToFallback: false,
        reservedTokens: estimate.reservedTokens,
        settledTokens,
      };
    } catch (primaryError) {
      const decision = evaluateFallbackPolicy(primaryError);

      if (!decision.shouldFallback) {
        this.limiter.releaseReservation(input.requestId);
        if (primaryError instanceof GatewayError) {
          throw primaryError;
        }
        throw new GatewayError(
          'MODEL_UNAVAILABLE',
          502,
          'Primary model provider failed with a non-retryable upstream error.',
        );
      }

      // Single-hop failover to secondary provider (no recursive retries).
      try {
        const secondaryResult = await invokeProviderWithTimeout(
          this.secondaryProvider,
          providerRequest,
          this.secondaryTimeoutMs,
          input.callerSignal,
        );

        const settledTokens = this.tokenCounter.reconcileActualTokens(
          estimate.promptTokens,
          secondaryResult.content,
          secondaryResult.usage,
        );
        this.limiter.settleReservation(input.requestId, settledTokens);

        return {
          completion: secondaryResult,
          routedToFallback: true,
          fallbackReason: decision.reason,
          reservedTokens: estimate.reservedTokens,
          settledTokens,
        };
      } catch (secondaryError) {
        this.limiter.releaseReservation(input.requestId);
        if (
          primaryError instanceof ProviderTimeoutError &&
          secondaryError instanceof ProviderTimeoutError
        ) {
          throw new GatewayError(
            'UPSTREAM_TIMEOUT',
            504,
            'All model providers timed out before completing the request.',
          );
        }

        throw new GatewayError(
          'MODEL_UNAVAILABLE',
          503,
          'All model providers are currently unavailable.',
        );
      }
    }
  }
}
