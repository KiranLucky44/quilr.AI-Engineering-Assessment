import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createRouterProviders, loadRouterConfig } from '../src/config.js';
import { openRouterDatabase } from '../src/database/database.js';
import {
  ProviderMalformedResponseError,
  type StandardizedErrorPayload,
} from '../src/errors/gateway-errors.js';
import { SlidingWindowLimiter } from '../src/limiter/sliding-window-limiter.js';
import { TiktokenTokenCounter } from '../src/limiter/token-counter.js';
import { MockPrimaryProvider } from '../src/providers/mock-primary.provider.js';
import { MockSecondaryProvider } from '../src/providers/mock-secondary.provider.js';
import {
  DEFAULT_OLLAMA_BASE_URL,
  DEFAULT_OLLAMA_MODEL,
  OpenAICompatibleModelProvider,
  parseOpenAIChatCompletionJson,
} from '../src/providers/openai-compatible.provider.js';
import { ModelRouter } from '../src/router/model-router.js';
import { createModelRouterServer, type ModelRouterServerHandle } from '../src/server.js';

async function listenHttpServer(srv: Server): Promise<number> {
  return await new Promise<number>((resolvePromise, rejectPromise) => {
    srv.once('error', rejectPromise);
    srv.listen(0, '127.0.0.1', () => {
      srv.removeListener('error', rejectPromise);
      resolvePromise((srv.address() as AddressInfo).port);
    });
  });
}

async function closeHttpServer(srv: Server): Promise<void> {
  if (!srv.listening) {
    return;
  }
  srv.closeAllConnections();
  await new Promise<void>((resolvePromise) => {
    srv.close(() => {
      resolvePromise();
    });
  });
}

describe('Task 4 OpenAICompatibleModelProvider Unit & Local HTTP Adapter Integration', () => {
  let tempDir: string;
  const activeServers: ModelRouterServerHandle[] = [];
  const activeUpstreams: Server[] = [];
  const activeDbClosers: Array<() => void> = [];

  beforeEach(() => {
    tempDir = mkdtempSync(join(tmpdir(), 'quill-task4-http-adapter-'));
  });

  afterEach(async () => {
    while (activeServers.length > 0) {
      const srv = activeServers.pop();
      if (srv) {
        await srv.close();
      }
    }
    while (activeUpstreams.length > 0) {
      const up = activeUpstreams.pop();
      if (up) {
        await closeHttpServer(up);
      }
    }
    while (activeDbClosers.length > 0) {
      const closeFn = activeDbClosers.pop();
      closeFn?.();
    }
    rmSync(tempDir, { recursive: true, force: true });
  });

  it('parses OpenAI-compatible chat completion JSON responses and rejects malformed payloads', () => {
    const parsedWithUsage = parseOpenAIChatCompletionJson(
      JSON.stringify({
        id: 'chatcmpl-ollama-101',
        object: 'chat.completion',
        created: 1769904500,
        model: 'llama3.2:1b',
        choices: [
          {
            index: 0,
            message: { role: 'assistant', content: 'Local Ollama response.' },
            finish_reason: 'stop',
          },
        ],
        usage: { prompt_tokens: 14, completion_tokens: 6, total_tokens: 20 },
      }),
      'ollama-primary',
      'llama3.2:1b',
      'req_1',
    );
    expect(parsedWithUsage).toEqual({
      id: 'chatcmpl-ollama-101',
      providerName: 'ollama-primary',
      model: 'llama3.2:1b',
      created: 1769904500,
      content: 'Local Ollama response.',
      finishReason: 'stop',
      usage: { promptTokens: 14, completionTokens: 6, totalTokens: 20 },
    });

    const parsedWithoutUsage = parseOpenAIChatCompletionJson(
      JSON.stringify({
        choices: [
          { message: { role: 'assistant', content: 'Truncated' }, finish_reason: 'length' },
        ],
      }),
      'ollama-secondary',
      'llama3.2:1b',
      'req_2',
    );
    expect(parsedWithoutUsage.id).toBe('chatcmpl_req_2');
    expect(parsedWithoutUsage.model).toBe('llama3.2:1b');
    expect(parsedWithoutUsage.finishReason).toBe('length');
    expect(parsedWithoutUsage.usage).toBeUndefined();

    expect(() =>
      parseOpenAIChatCompletionJson('{broken', 'ollama-primary', 'llama3.2:1b', 'req_3'),
    ).toThrow(ProviderMalformedResponseError);
    expect(() =>
      parseOpenAIChatCompletionJson('{"choices":[]}', 'ollama-primary', 'llama3.2:1b', 'req_4'),
    ).toThrow(ProviderMalformedResponseError);
    expect(() =>
      parseOpenAIChatCompletionJson(
        '{"choices":[{"message":{}}]}',
        'ollama-primary',
        'llama3.2:1b',
        'req_5',
      ),
    ).toThrow(ProviderMalformedResponseError);
  });

  it('supports independent Primary and Secondary provider configuration while defaulting to mock', () => {
    const defaultCfg = loadRouterConfig({});
    expect(defaultCfg.primaryProvider?.mode).toBe('mock');
    expect(defaultCfg.secondaryProvider?.mode).toBe('mock');
    const defaultProviders = createRouterProviders(defaultCfg);
    expect(defaultProviders.primaryProvider).toBeInstanceOf(MockPrimaryProvider);
    expect(defaultProviders.secondaryProvider).toBeInstanceOf(MockSecondaryProvider);

    const ollamaAllCfg = loadRouterConfig({
      LLM_PROVIDER: 'ollama',
      OLLAMA_BASE_URL: DEFAULT_OLLAMA_BASE_URL,
      OLLAMA_MODEL: DEFAULT_OLLAMA_MODEL,
    });
    expect(ollamaAllCfg.primaryProvider?.mode).toBe('ollama');
    expect(ollamaAllCfg.secondaryProvider?.mode).toBe('ollama');
    expect(ollamaAllCfg.primaryProvider?.model).toBe('llama3.2:1b');

    const hybridCfg = loadRouterConfig({
      ROUTER_PRIMARY_PROVIDER: 'mock',
      ROUTER_SECONDARY_PROVIDER: 'openai-compatible',
      ROUTER_SECONDARY_BASE_URL: 'http://127.0.0.1:11434/v1',
      ROUTER_SECONDARY_MODEL: 'llama3.2:1b',
      ROUTER_SECONDARY_API_KEY: 'local-optional-token',
    });
    const hybridProviders = createRouterProviders(hybridCfg);
    expect(hybridProviders.primaryProvider).toBeInstanceOf(MockPrimaryProvider);
    expect(hybridProviders.secondaryProvider).toBeInstanceOf(OpenAICompatibleModelProvider);
  });

  it('routes through HTTP OpenAICompatibleModelProvider adapters on 200, local-stubbed 429 failover, and timeout cancellation', async () => {
    let primaryMode: 'ok' | 'http_429' | 'slow_timeout' = 'ok';
    let primaryAuthSeen: string | undefined;
    let primaryModelSeen: string | undefined;
    let secondaryModelSeen: string | undefined;

    // Local in-process HTTP server simulating an OpenAI-compatible primary endpoint
    const primaryUpstream = createServer((req, res) => {
      primaryAuthSeen = req.headers['authorization'];
      const chunks: Buffer[] = [];
      req.on('data', (c: Buffer) => chunks.push(c));
      req.on('end', () => {
        const body = JSON.parse(Buffer.concat(chunks).toString('utf8')) as { model: string };
        primaryModelSeen = body.model;

        if (primaryMode === 'http_429') {
          res.writeHead(429, { 'content-type': 'application/json' });
          res.end(JSON.stringify({ error: { message: 'Local test server simulated 429' } }));
          return;
        }

        if (primaryMode === 'slow_timeout') {
          const timer = setTimeout(() => {
            if (!res.writableEnded) {
              res.writeHead(200, { 'content-type': 'application/json' });
              res.end('{}');
            }
          }, 1500);
          req.once('close', () => {
            clearTimeout(timer);
          });
          res.once('close', () => {
            clearTimeout(timer);
          });
          return;
        }

        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(
          JSON.stringify({
            id: 'chatcmpl-primary-real-http',
            object: 'chat.completion',
            created: 1769904600,
            model: body.model,
            choices: [
              {
                index: 0,
                message: { role: 'assistant', content: 'Primary HTTP adapter completion.' },
                finish_reason: 'stop',
              },
            ],
            usage: { prompt_tokens: 12, completion_tokens: 8, total_tokens: 20 },
          }),
        );
      });
    });
    activeUpstreams.push(primaryUpstream);
    const primaryPort = await listenHttpServer(primaryUpstream);

    // Local in-process HTTP server simulating an OpenAI-compatible secondary failover endpoint
    const secondaryUpstream = createServer((req, res) => {
      const chunks: Buffer[] = [];
      req.on('data', (c: Buffer) => chunks.push(c));
      req.on('end', () => {
        const body = JSON.parse(Buffer.concat(chunks).toString('utf8')) as { model: string };
        secondaryModelSeen = body.model;
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(
          JSON.stringify({
            id: 'chatcmpl-secondary-real-http',
            object: 'chat.completion',
            created: 1769904605,
            model: body.model,
            choices: [
              {
                index: 0,
                message: {
                  role: 'assistant',
                  content: 'Secondary HTTP adapter failover completion.',
                },
                finish_reason: 'stop',
              },
            ],
            usage: { prompt_tokens: 12, completion_tokens: 10, total_tokens: 22 },
          }),
        );
      });
    });
    activeUpstreams.push(secondaryUpstream);
    const secondaryPort = await listenHttpServer(secondaryUpstream);

    const db = openRouterDatabase({ dbPath: join(tempDir, 'adapter-router.sqlite') });
    activeDbClosers.push(() => db.close());

    const limiter = new SlidingWindowLimiter({ db, quotaLimit: 5000, windowMs: 60_000 });
    const primaryAdapter = new OpenAICompatibleModelProvider({
      providerName: 'ollama-primary',
      baseUrl: `http://127.0.0.1:${primaryPort}/v1`,
      configuredModel: 'llama3.2:3b',
      apiKey: 'primary-local-token',
    });
    const secondaryAdapter = new OpenAICompatibleModelProvider({
      providerName: 'ollama-secondary',
      baseUrl: `http://127.0.0.1:${secondaryPort}/v1`,
      configuredModel: 'llama3.2:1b',
    });

    const router = new ModelRouter({
      primaryProvider: primaryAdapter,
      secondaryProvider: secondaryAdapter,
      limiter,
      tokenCounter: new TiktokenTokenCounter(),
      primaryTimeoutMs: 90,
      secondaryTimeoutMs: 1000,
    });

    const server = createModelRouterServer({ router, silentLogs: true });
    activeServers.push(server);
    const routerPort = await server.listen(0, '127.0.0.1');
    const url = `http://127.0.0.1:${routerPort}/v1/chat/completions`;

    // 1. Primary 200 OK
    const okRes = await fetch(url, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        authorization: 'Bearer tenant-alpha',
      },
      body: JSON.stringify({
        model: 'client-requested-model',
        max_tokens: 64,
        messages: [{ role: 'user', content: 'Hello primary adapter' }],
      }),
    });
    expect(okRes.status).toBe(200);
    const okBody = (await okRes.json()) as {
      provider: string;
      routed_via_fallback: boolean;
      usage: { total_tokens: number };
    };
    expect(okBody.provider).toBe('ollama-primary');
    expect(okBody.routed_via_fallback).toBe(false);
    expect(okBody.usage.total_tokens).toBe(20);
    expect(primaryAuthSeen).toBe('Bearer primary-local-token');
    expect(primaryModelSeen).toBe('llama3.2:3b');

    // 2. Primary local test server returns HTTP 429 -> Secondary adapter invoked with its own model
    primaryMode = 'http_429';
    const fb429Res = await fetch(url, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        authorization: 'Bearer tenant-alpha',
      },
      body: JSON.stringify({
        model: 'client-requested-model',
        max_tokens: 64,
        messages: [{ role: 'user', content: 'Trigger 429 failover' }],
      }),
    });
    expect(fb429Res.status).toBe(200);
    const fb429Body = (await fb429Res.json()) as {
      provider: string;
      routed_via_fallback: boolean;
      model: string;
    };
    expect(fb429Body.provider).toBe('ollama-secondary');
    expect(fb429Body.routed_via_fallback).toBe(true);
    expect(secondaryModelSeen).toBe('llama3.2:1b');

    // 3. Primary local test server stalls -> cancelled via AbortSignal + Secondary adapter fulfills
    primaryMode = 'slow_timeout';
    const fbTimeoutRes = await fetch(url, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        authorization: 'Bearer tenant-alpha',
      },
      body: JSON.stringify({
        model: 'client-requested-model',
        max_tokens: 64,
        messages: [{ role: 'user', content: 'Trigger timeout failover' }],
      }),
    });
    expect(fbTimeoutRes.status).toBe(200);
    const fbTimeoutBody = (await fbTimeoutRes.json()) as {
      provider: string;
      routed_via_fallback: boolean;
    };
    expect(fbTimeoutBody.provider).toBe('ollama-secondary');
    expect(fbTimeoutBody.routed_via_fallback).toBe(true);
    expect(primaryAdapter.cancelledCount).toBe(1);
  });

  it('maps upstream connection errors and malformed JSON to sanitized MODEL_UNAVAILABLE and releases SQLite reservation', async () => {
    const closedSrv = createServer();
    const closedPort = await listenHttpServer(closedSrv);
    await closeHttpServer(closedSrv);

    const malformedSrv = createServer((_req, res) => {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end('NOT_VALID_JSON');
    });
    activeUpstreams.push(malformedSrv);
    const malformedPort = await listenHttpServer(malformedSrv);

    const db = openRouterDatabase({ dbPath: join(tempDir, 'error-router.sqlite') });
    activeDbClosers.push(() => db.close());
    const limiter = new SlidingWindowLimiter({ db, quotaLimit: 500, windowMs: 60_000 });

    // Case A: Connection refused on primary -> non-429/non-timeout -> 502 MODEL_UNAVAILABLE + reservation released
    const connRouter = new ModelRouter({
      primaryProvider: new OpenAICompatibleModelProvider({
        providerName: 'unreachable-primary',
        baseUrl: `http://127.0.0.1:${closedPort}/v1`,
        apiKey: 'secret-upstream-token-999',
      }),
      secondaryProvider: new MockSecondaryProvider(),
      limiter,
      tokenCounter: new TiktokenTokenCounter(),
    });
    const connServer = createModelRouterServer({ router: connRouter, silentLogs: true });
    activeServers.push(connServer);
    const connRouterPort = await connServer.listen(0, '127.0.0.1');

    const connRes = await fetch(`http://127.0.0.1:${connRouterPort}/v1/chat/completions`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        authorization: 'Bearer tenant-release-check',
      },
      body: JSON.stringify({
        model: 'llama3.2:1b',
        max_tokens: 200,
        messages: [{ role: 'user', content: 'Test connection failure' }],
      }),
    });
    expect(connRes.status).toBe(502);
    const connText = await connRes.text();
    expect(connText).not.toContain('secret-upstream-token-999');
    expect(connText).not.toContain(String(closedPort));
    const connJson = JSON.parse(connText) as StandardizedErrorPayload;
    expect(connJson.error.code).toBe('MODEL_UNAVAILABLE');
    expect(limiter.getActiveTenantUsage('tenant-release-check')).toBe(0);

    // Case B: Malformed upstream JSON -> 502 MODEL_UNAVAILABLE + reservation released
    const malformedRouter = new ModelRouter({
      primaryProvider: new OpenAICompatibleModelProvider({
        providerName: 'malformed-primary',
        baseUrl: `http://127.0.0.1:${malformedPort}/v1`,
      }),
      secondaryProvider: new MockSecondaryProvider(),
      limiter,
      tokenCounter: new TiktokenTokenCounter(),
    });
    const malformedServer = createModelRouterServer({ router: malformedRouter, silentLogs: true });
    activeServers.push(malformedServer);
    const malformedRouterPort = await malformedServer.listen(0, '127.0.0.1');

    const badRes = await fetch(`http://127.0.0.1:${malformedRouterPort}/v1/chat/completions`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        authorization: 'Bearer tenant-release-check',
      },
      body: JSON.stringify({
        model: 'llama3.2:1b',
        max_tokens: 200,
        messages: [{ role: 'user', content: 'Test malformed upstream body' }],
      }),
    });
    expect(badRes.status).toBe(502);
    expect(limiter.getActiveTenantUsage('tenant-release-check')).toBe(0);
  });

  describe.runIf(process.env['OLLAMA_LIVE_TEST'] === 'true')(
    'Live Local Ollama End-to-End Router Verification (Opt-In)',
    () => {
      it('routes completion to live local Ollama and settles SQLite token usage', async () => {
        const liveModel = process.env['OLLAMA_MODEL'] ?? DEFAULT_OLLAMA_MODEL;
        const liveBaseUrl = process.env['OLLAMA_BASE_URL'] ?? DEFAULT_OLLAMA_BASE_URL;

        const db = openRouterDatabase({ dbPath: join(tempDir, 'live-ollama.sqlite') });
        activeDbClosers.push(() => db.close());
        const limiter = new SlidingWindowLimiter({ db, quotaLimit: 10_000, windowMs: 60_000 });

        const router = new ModelRouter({
          primaryProvider: new OpenAICompatibleModelProvider({
            providerName: 'ollama-primary',
            baseUrl: liveBaseUrl,
            configuredModel: liveModel,
            timeoutMs: 25_000,
          }),
          secondaryProvider: new MockSecondaryProvider(),
          limiter,
          tokenCounter: new TiktokenTokenCounter(),
          primaryTimeoutMs: 25_000,
        });

        const server = createModelRouterServer({ router, silentLogs: true });
        activeServers.push(server);
        const port = await server.listen(0, '127.0.0.1');

        const res = await fetch(`http://127.0.0.1:${port}/v1/chat/completions`, {
          method: 'POST',
          headers: {
            'content-type': 'application/json',
            authorization: 'Bearer live-ollama-tenant',
          },
          body: JSON.stringify({
            model: liveModel,
            max_tokens: 32,
            temperature: 0,
            messages: [{ role: 'user', content: 'Reply with the single word READY.' }],
          }),
        });

        expect(res.status).toBe(200);
        const body = (await res.json()) as {
          provider: string;
          routed_via_fallback: boolean;
          choices: Array<{ message: { content: string } }>;
          usage: { total_tokens: number };
        };
        expect(body.provider).toBe('ollama-primary');
        expect(body.routed_via_fallback).toBe(false);
        expect(body.choices[0]?.message.content.length).toBeGreaterThan(0);
        expect(limiter.getActiveTenantUsage('live-ollama-tenant')).toBe(body.usage.total_tokens);
      }, 30_000);
    },
  );
});
