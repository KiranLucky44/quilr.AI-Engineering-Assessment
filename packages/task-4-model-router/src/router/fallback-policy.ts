import { ProviderHttpError, ProviderTimeoutError } from '../errors/gateway-errors.js';

export type FallbackTriggerReason = 'PRIMARY_HTTP_429' | 'PRIMARY_TIMEOUT';

export type FallbackDecision =
  | {
      readonly shouldFallback: true;
      readonly reason: FallbackTriggerReason;
    }
  | {
      readonly shouldFallback: false;
    };

/**
 * Evaluates Task 4 failover policy for primary model failures.
 *
 * Failover is triggered EXCLUSIVELY when:
 * 1. The primary provider returns HTTP 429 (rate-limited / capacity exhausted).
 * 2. The primary provider exceeds the configured timeout (default 3,000ms).
 *
 * Generic 500 internal errors, 4xx validation errors, and unexpected exceptions
 * do NOT trigger automatic silent failover.
 */
export function evaluateFallbackPolicy(error: unknown): FallbackDecision {
  if (error instanceof ProviderHttpError && error.statusCode === 429) {
    return {
      shouldFallback: true,
      reason: 'PRIMARY_HTTP_429',
    };
  }

  if (error instanceof ProviderTimeoutError) {
    return {
      shouldFallback: true,
      reason: 'PRIMARY_TIMEOUT',
    };
  }

  return {
    shouldFallback: false,
  };
}
