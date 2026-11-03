import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { openRouterDatabase } from '../src/database/database.js';
import { GatewayError } from '../src/errors/gateway-errors.js';
import { SlidingWindowLimiter } from '../src/limiter/sliding-window-limiter.js';
import { TiktokenTokenCounter } from '../src/limiter/token-counter.js';
import { MockPrimaryProvider } from '../src/providers/mock-primary.provider.js';
import { MockSecondaryProvider } from '../src/providers/mock-secondary.provider.js';
import { ModelRouter } from '../src/router/model-router.js';

describe('ModelRouter Failover Policy & Timeout Cancellation (Task 4)', () => {
  const tempDirs: string[] = [];

  afterEach(() => {
    vi.useRealTimers();
    while (tempDirs.length > 0) {
      const dir = tempDirs.pop();
      if (dir) {
        rmSync(dir, { recursive: true, force: true });
      }
    }
  });

  function createHarness(): {
    router: ModelRouter;
    primary: MockPrimaryProvider;
    secondary: MockSecondaryProvider;
    limiter: SlidingWindowLimiter;
    cleanup: () => void;
  } {
    const dir = mkdtempSync(join(tmpdir(), 'quill-task4-fb-'));
    tempDirs.push(dir);
    const db = openRouterDatabase({ dbPath: join(dir, 'router.sqlite') });

    const primary = new MockPrimaryProvider({ timeoutScenarioLatencyMs: 5_000 });
    const secondary = new MockSecondaryProvider();
    const limiter = new SlidingWindowLimiter({ db, quotaLimit: 50_000 });
    const tokenCounter = new TiktokenTokenCounter();

    const router = new ModelRouter({
      primaryProvider: primary,
      secondaryProvider: secondary,
      limiter,
      tokenCounter,
      primaryTimeoutMs: 3_000,
      secondaryTimeoutMs: 3_000,
    });

    return {
      router,
      primary,
      secondary,
      limiter,
      cleanup: () => {
        db.close();
      },
    };
  }

  it('routes to primary provider on normal success without invoking secondary fallback', async () => {
    const h = createHarness();
    const res = await h.router.routeChatCompletion({
      requestId: 'req_ok_1',
      tenantApiKey: 'sk-tenant-1',
      model: 'quill-primary-v1',
      messages: [{ role: 'user', content: 'Check system status' }],
      scenario: 'success',
    });

    expect(res.routedToFallback).toBe(false);
    expect(res.completion.providerName).toBe('mock-primary');
    expect(h.primary.invocationCount).toBe(1);
    expect(h.secondary.invocationCount).toBe(0);
    h.cleanup();
  });

  it('triggers secondary failover when primary returns HTTP 429', async () => {
    const h = createHarness();
    const res = await h.router.routeChatCompletion({
      requestId: 'req_429_1',
      tenantApiKey: 'sk-tenant-1',
      model: 'quill-primary-v1',
      messages: [{ role: 'user', content: 'Trigger 429 failover' }],
      scenario: 'primary_429',
    });

    expect(res.routedToFallback).toBe(true);
    expect(res.fallbackReason).toBe('PRIMARY_HTTP_429');
    expect(res.completion.providerName).toBe('mock-secondary');
    expect(h.primary.invocationCount).toBe(1);
    expect(h.secondary.invocationCount).toBe(1);
    h.cleanup();
  });

  it('cancels primary via AbortController at 3,000ms timeout and fails over to secondary (fast fake timers)', async () => {
    vi.useFakeTimers();
    const h = createHarness();

    const routePromise = h.router.routeChatCompletion({
      requestId: 'req_timeout_1',
      tenantApiKey: 'sk-tenant-1',
      model: 'quill-primary-v1',
      messages: [{ role: 'user', content: 'Simulate slow primary >3s' }],
      scenario: 'primary_timeout',
    });

    // Advance virtual clock by exact 3,000ms primary timeout threshold
    await vi.advanceTimersByTimeAsync(3_000);

    const res = await routePromise;
    expect(h.primary.cancelledCount).toBe(1);
    expect(res.routedToFallback).toBe(true);
    expect(res.fallbackReason).toBe('PRIMARY_TIMEOUT');
    expect(res.completion.providerName).toBe('mock-secondary');
    expect(h.secondary.invocationCount).toBe(1);
    h.cleanup();
  });

  it('does NOT trigger fallback on generic primary HTTP 500 and sanitizes upstream internals', async () => {
    const h = createHarness();

    await expect(
      h.router.routeChatCompletion({
        requestId: 'req_500_1',
        tenantApiKey: 'sk-tenant-500',
        model: 'quill-primary-v1',
        messages: [{ role: 'user', content: 'Simulate primary 500' }],
        scenario: 'primary_500',
      }),
    ).rejects.toSatisfy((err: unknown) => {
      if (!(err instanceof GatewayError)) {
        return false;
      }
      expect(err.code).toBe('MODEL_UNAVAILABLE');
      expect(err.message).not.toContain('CUDA');
      expect(err.message).not.toContain('/opt/inference/engine.cpp');
      return true;
    });

    expect(h.primary.invocationCount).toBe(1);
    expect(h.secondary.invocationCount).toBe(0);
    // Reservation must be cleanly released on failure
    expect(h.limiter.getActiveTenantUsage('sk-tenant-500')).toBe(0);
    h.cleanup();
  });

  it('returns sanitized MODEL_UNAVAILABLE error when both primary and secondary providers fail', async () => {
    const h = createHarness();

    await expect(
      h.router.routeChatCompletion({
        requestId: 'req_both_down',
        tenantApiKey: 'sk-tenant-both',
        model: 'quill-primary-v1',
        messages: [{ role: 'user', content: 'Both clusters down' }],
        scenario: 'both_unavailable',
      }),
    ).rejects.toSatisfy((err: unknown) => {
      if (!(err instanceof GatewayError)) {
        return false;
      }
      expect(err.code).toBe('MODEL_UNAVAILABLE');
      expect(err.httpStatus).toBe(503);
      expect(err.message).toBe('All model providers are currently unavailable.');
      expect(err.message).not.toContain('backup-node-03.internal');
      expect(err.message).not.toContain('primary-internal-01.corp');
      return true;
    });

    expect(h.primary.invocationCount).toBe(1);
    expect(h.secondary.invocationCount).toBe(1);
    expect(h.limiter.getActiveTenantUsage('sk-tenant-both')).toBe(0);
    h.cleanup();
  });
});
