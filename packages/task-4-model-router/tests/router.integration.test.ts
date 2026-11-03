import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { openRouterDatabase } from '../src/database/database.js';
import type { StandardizedErrorPayload } from '../src/errors/gateway-errors.js';
import { SlidingWindowLimiter } from '../src/limiter/sliding-window-limiter.js';
import { TiktokenTokenCounter } from '../src/limiter/token-counter.js';
import { MockPrimaryProvider } from '../src/providers/mock-primary.provider.js';
import { MockSecondaryProvider } from '../src/providers/mock-secondary.provider.js';
import { ModelRouter } from '../src/router/model-router.js';
import { createModelRouterServer, type ModelRouterServerHandle } from '../src/server.js';

describe('Task 4 HTTP Model Router End-to-End Integration', () => {
  let tempDir: string;
  let closeDb: () => void;
  let server: ModelRouterServerHandle;
  let baseUrl: string;

  beforeEach(async () => {
    tempDir = mkdtempSync(join(tmpdir(), 'quill-task4-http-'));
    const db = openRouterDatabase({ dbPath: join(tempDir, 'http-router.sqlite') });
    closeDb = () => {
      db.close();
    };

    const limiter = new SlidingWindowLimiter({
      db,
      quotaLimit: 500, // Small configurable test quota
      windowMs: 60_000,
    });

    const router = new ModelRouter({
      primaryProvider: new MockPrimaryProvider({ timeoutScenarioLatencyMs: 250 }),
      secondaryProvider: new MockSecondaryProvider(),
      limiter,
      tokenCounter: new TiktokenTokenCounter(),
      primaryTimeoutMs: 80,
      secondaryTimeoutMs: 500,
      defaultMaxTokens: 100,
      windowMs: 60_000,
    });

    server = createModelRouterServer({ router, silentLogs: true });
    const port = await server.listen(0, '127.0.0.1');
    baseUrl = `http://127.0.0.1:${port}/v1/chat/completions`;
  });

  afterEach(async () => {
    await server.close();
    closeDb();
    rmSync(tempDir, { recursive: true, force: true });
  });

  it('returns 401 UNAUTHORIZED with consistent request_id when Authorization Bearer key is missing', async () => {
    const res = await fetch(baseUrl, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        model: 'quill-gpt',
        messages: [{ role: 'user', content: 'Hello' }],
      }),
    });

    expect(res.status).toBe(401);
    const headerReqId = res.headers.get('x-request-id');
    expect(headerReqId).toMatch(/^req_/);

    const body = (await res.json()) as StandardizedErrorPayload;
    expect(body.error.code).toBe('UNAUTHORIZED');
    expect(body.error.request_id).toBe(headerReqId);
  });

  it('returns 200 on primary success and 200 via secondary failover on primary_429 and primary_timeout', async () => {
    const okRes = await fetch(baseUrl, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        authorization: 'Bearer sk-http-tenant-ok',
      },
      body: JSON.stringify({
        model: 'quill-gpt',
        max_tokens: 50,
        messages: [{ role: 'user', content: 'Primary request' }],
      }),
    });
    expect(okRes.status).toBe(200);
    const okBody = (await okRes.json()) as {
      provider: string;
      routed_via_fallback: boolean;
      request_id: string;
    };
    expect(okBody.provider).toBe('mock-primary');
    expect(okBody.routed_via_fallback).toBe(false);
    expect(okBody.request_id).toBe(okRes.headers.get('x-request-id'));

    const fallback429Res = await fetch(baseUrl, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        authorization: 'Bearer sk-http-tenant-ok',
      },
      body: JSON.stringify({
        model: 'quill-gpt',
        max_tokens: 50,
        mock_scenario: 'primary_429',
        messages: [{ role: 'user', content: 'Failover 429 request' }],
      }),
    });
    expect(fallback429Res.status).toBe(200);
    const fbBody = (await fallback429Res.json()) as {
      provider: string;
      routed_via_fallback: boolean;
    };
    expect(fbBody.provider).toBe('mock-secondary');
    expect(fbBody.routed_via_fallback).toBe(true);

    const fallbackTimeoutRes = await fetch(baseUrl, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        authorization: 'Bearer sk-http-tenant-ok',
      },
      body: JSON.stringify({
        model: 'quill-gpt',
        max_tokens: 50,
        mock_scenario: 'primary_timeout',
        messages: [{ role: 'user', content: 'Failover timeout request' }],
      }),
    });
    expect(fallbackTimeoutRes.status).toBe(200);
    const timeoutFbBody = (await fallbackTimeoutRes.json()) as {
      provider: string;
      routed_via_fallback: boolean;
    };
    expect(timeoutFbBody.provider).toBe('mock-secondary');
    expect(timeoutFbBody.routed_via_fallback).toBe(true);
  });

  it('enforces HTTP 429 RATE_LIMIT_EXCEEDED with Retry-After when tenant exceeds quota', async () => {
    // Quota is 500; reserving max_tokens: 495 + promptTokens (>10) > 500 immediately rejects
    const exceededRes = await fetch(baseUrl, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        authorization: 'Bearer sk-quota-test-tenant',
      },
      body: JSON.stringify({
        model: 'quill-gpt',
        max_tokens: 495,
        messages: [{ role: 'user', content: 'Exceed my 500 token quota immediately' }],
      }),
    });

    expect(exceededRes.status).toBe(429);
    expect(exceededRes.headers.get('retry-after')).toBeTruthy();

    const body = (await exceededRes.json()) as StandardizedErrorPayload;
    expect(body.error.code).toBe('RATE_LIMIT_EXCEEDED');
    expect(body.error.request_id).toBe(exceededRes.headers.get('x-request-id'));
    expect(body.error.retry_after_ms).toBeGreaterThan(0);
  });

  it('returns standardized sanitized MODEL_UNAVAILABLE error when both providers fail', async () => {
    const res = await fetch(baseUrl, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        authorization: 'Bearer sk-secret-never-echo-me',
      },
      body: JSON.stringify({
        model: 'quill-gpt',
        max_tokens: 50,
        mock_scenario: 'both_unavailable',
        messages: [{ role: 'user', content: 'Test total outage' }],
      }),
    });

    expect(res.status).toBe(503);
    const rawText = await res.text();
    expect(rawText).not.toContain('sk-secret-never-echo-me');
    expect(rawText).not.toContain('.sqlite');

    const parsed = JSON.parse(rawText) as StandardizedErrorPayload;
    expect(parsed).toEqual({
      error: {
        code: 'MODEL_UNAVAILABLE',
        message: 'All model providers are currently unavailable.',
        request_id: res.headers.get('x-request-id'),
      },
    });
  });
});
