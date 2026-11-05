import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { createConfiguredStreamProvider, loadStreamingGatewayConfig } from '../src/config.js';
import { MockLLMProvider } from '../src/providers/mock-llm.provider.js';
import {
  DEFAULT_OLLAMA_BASE_URL,
  DEFAULT_OLLAMA_MODEL,
  OllamaProvider,
  parseOpenAICompatibleChunkJson,
  UpstreamStreamProviderError,
} from '../src/providers/ollama.provider.js';
import { createStreamingGuardrailServer, type StreamingGatewayHandle } from '../src/server.js';
import { findPiiMatches } from '../src/streaming/pii-patterns.js';

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

describe('Task 3 OllamaProvider Unit & Upstream HTTP Streaming Integration', () => {
  const activeGateways: StreamingGatewayHandle[] = [];
  const activeUpstreams: Server[] = [];

  afterEach(async () => {
    while (activeGateways.length > 0) {
      const gw = activeGateways.pop();
      if (gw) {
        await gw.close();
      }
    }
    while (activeUpstreams.length > 0) {
      const srv = activeUpstreams.pop();
      if (srv) {
        await closeHttpServer(srv);
      }
    }
  });

  it('parses Ollama / OpenAI-compatible SSE chunk JSON deltas and rejects malformed payloads', () => {
    const initialDelta = parseOpenAICompatibleChunkJson(
      JSON.stringify({
        id: 'chatcmpl-901',
        object: 'chat.completion.chunk',
        created: 1769904000,
        model: 'llama3.2:1b',
        system_fingerprint: 'fp_ollama',
        choices: [
          { index: 0, delta: { role: 'assistant', content: 'Hello ' }, finish_reason: null },
        ],
      }),
      'llama3.2:1b',
    );
    expect(initialDelta).toEqual({
      id: 'chatcmpl-901',
      created: 1769904000,
      model: 'llama3.2:1b',
      systemFingerprint: 'fp_ollama',
      role: 'assistant',
      contentDelta: 'Hello ',
      finishReason: null,
    });

    const stopDelta = parseOpenAICompatibleChunkJson(
      JSON.stringify({
        id: 'chatcmpl-901',
        created: 1769904000,
        model: 'llama3.2:1b',
        choices: [{ index: 0, delta: { role: 'assistant', content: '' }, finish_reason: 'stop' }],
      }),
      'llama3.2:1b',
    );
    expect(stopDelta?.finishReason).toBe('stop');
    expect(stopDelta?.contentDelta).toBe('');

    expect(
      parseOpenAICompatibleChunkJson(
        JSON.stringify({ id: 'chatcmpl-empty', choices: [] }),
        'llama3.2:1b',
      ),
    ).toBeNull();

    expect(() => parseOpenAICompatibleChunkJson('{bad-json', 'llama3.2:1b')).toThrow(
      UpstreamStreamProviderError,
    );
    expect(() =>
      parseOpenAICompatibleChunkJson(
        JSON.stringify({ error: { message: 'model not found' } }),
        'llama3.2:1b',
      ),
    ).toThrow(UpstreamStreamProviderError);
    expect(() =>
      parseOpenAICompatibleChunkJson(JSON.stringify({ id: 'no-choices' }), 'llama3.2:1b'),
    ).toThrow(UpstreamStreamProviderError);
  });

  it('defaults to MockLLMProvider and supports switching to OllamaProvider via env or .env file', () => {
    const defaultCfg = loadStreamingGatewayConfig({});
    expect(defaultCfg.providerMode).toBe('mock');
    expect(defaultCfg.ollamaBaseUrl).toBe(DEFAULT_OLLAMA_BASE_URL);
    expect(defaultCfg.ollamaModel).toBe(DEFAULT_OLLAMA_MODEL);
    expect(createConfiguredStreamProvider(defaultCfg)).toBeInstanceOf(MockLLMProvider);

    const tempDir = mkdtempSync(join(tmpdir(), 'quill-task3-env-'));
    try {
      const envFile = join(tempDir, '.env');
      writeFileSync(
        envFile,
        'LLM_PROVIDER=ollama\nOLLAMA_BASE_URL=http://127.0.0.1:11434/v1\nOLLAMA_MODEL=llama3.2:1b\n',
        'utf8',
      );
      const savedProvider = process.env['LLM_PROVIDER'];
      const savedModel = process.env['OLLAMA_MODEL'];
      const savedBaseUrl = process.env['OLLAMA_BASE_URL'];
      delete process.env['LLM_PROVIDER'];
      delete process.env['OLLAMA_MODEL'];
      delete process.env['OLLAMA_BASE_URL'];
      try {
        const dotEnvCfg = loadStreamingGatewayConfig(undefined, { envFilePaths: [envFile] });
        expect(dotEnvCfg.providerMode).toBe('ollama');
        expect(dotEnvCfg.ollamaModel).toBe('llama3.2:1b');
        expect(createConfiguredStreamProvider(dotEnvCfg)).toBeInstanceOf(OllamaProvider);
      } finally {
        if (savedProvider !== undefined) {
          process.env['LLM_PROVIDER'] = savedProvider;
        }
        if (savedModel !== undefined) {
          process.env['OLLAMA_MODEL'] = savedModel;
        }
        if (savedBaseUrl !== undefined) {
          process.env['OLLAMA_BASE_URL'] = savedBaseUrl;
        }
      }
    } finally {
      rmSync(tempDir, { recursive: true, force: true });
    }

    expect(() => loadStreamingGatewayConfig({ LLM_PROVIDER: 'unsupported-provider' })).toThrow(
      /Invalid LLM_PROVIDER/i,
    );
  });

  it('streams from a mocked HTTP OpenAI-compatible Ollama server and redacts split PII deltas in real time', async () => {
    let capturedAuthHeader: string | undefined;
    let capturedRequestBody = '';

    const mockOllamaHttp = createServer((req, res) => {
      capturedAuthHeader = req.headers['authorization'];
      const bodyChunks: Buffer[] = [];
      req.on('data', (c: Buffer) => bodyChunks.push(c));
      req.on('end', () => {
        capturedRequestBody = Buffer.concat(bodyChunks).toString('utf8');
        res.writeHead(200, {
          'content-type': 'text/event-stream; charset=utf-8',
          'cache-control': 'no-cache',
        });

        const frames = [
          {
            id: 'chatcmpl-ollama-77',
            object: 'chat.completion.chunk',
            created: 1769904100,
            model: 'llama3.2:1b',
            system_fingerprint: 'fp_ollama',
            choices: [
              { index: 0, delta: { role: 'assistant', content: 'Reach ' }, finish_reason: null },
            ],
          },
          {
            id: 'chatcmpl-ollama-77',
            object: 'chat.completion.chunk',
            created: 1769904100,
            model: 'llama3.2:1b',
            system_fingerprint: 'fp_ollama',
            choices: [
              {
                index: 0,
                delta: { role: 'assistant', content: 'alice.ops@' },
                finish_reason: null,
              },
            ],
          },
          {
            id: 'chatcmpl-ollama-77',
            object: 'chat.completion.chunk',
            created: 1769904100,
            model: 'llama3.2:1b',
            system_fingerprint: 'fp_ollama',
            choices: [
              {
                index: 0,
                delta: { role: 'assistant', content: 'quill-local.io or SSN 123-' },
                finish_reason: null,
              },
            ],
          },
          {
            id: 'chatcmpl-ollama-77',
            object: 'chat.completion.chunk',
            created: 1769904100,
            model: 'llama3.2:1b',
            system_fingerprint: 'fp_ollama',
            choices: [
              {
                index: 0,
                delta: {
                  role: 'assistant',
                  content: '45-6789 and card 4111-1111-',
                },
                finish_reason: null,
              },
            ],
          },
          {
            id: 'chatcmpl-ollama-77',
            object: 'chat.completion.chunk',
            created: 1769904100,
            model: 'llama3.2:1b',
            system_fingerprint: 'fp_ollama',
            choices: [
              {
                index: 0,
                delta: { role: 'assistant', content: '1111-1111.' },
                finish_reason: null,
              },
            ],
          },
          {
            id: 'chatcmpl-ollama-77',
            object: 'chat.completion.chunk',
            created: 1769904100,
            model: 'llama3.2:1b',
            system_fingerprint: 'fp_ollama',
            choices: [
              { index: 0, delta: { role: 'assistant', content: '' }, finish_reason: 'stop' },
            ],
          },
        ];

        for (const frame of frames) {
          res.write(`data: ${JSON.stringify(frame)}\n\n`);
        }
        res.end('data: [DONE]\n\n');
      });
    });
    activeUpstreams.push(mockOllamaHttp);
    const ollamaPort = await listenHttpServer(mockOllamaHttp);

    const provider = new OllamaProvider({
      baseUrl: `http://127.0.0.1:${ollamaPort}/v1`,
      defaultModel: 'llama3.2:1b',
      apiKey: 'local-test-key',
      timeoutMs: 5000,
    });
    const gateway = createStreamingGuardrailServer({ provider, silentLogs: true });
    activeGateways.push(gateway);
    const gwPort = await gateway.listen(0, '127.0.0.1');

    const res = await fetch(`http://127.0.0.1:${gwPort}/v1/chat/completions`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        model: 'ollama',
        stream: true,
        messages: [{ role: 'user', content: 'Provide synthetic contact details' }],
      }),
    });

    expect(res.status).toBe(200);
    const rawSse = await res.text();
    expect(rawSse.endsWith('data: [DONE]\n\n')).toBe(true);
    expect(capturedAuthHeader).toBe('Bearer local-test-key');

    const forwardedPayload = JSON.parse(capturedRequestBody) as { model: string; stream: boolean };
    expect(forwardedPayload.model).toBe('llama3.2:1b');
    expect(forwardedPayload.stream).toBe(true);

    // Inspect every emitted SSE event for raw or partial PII leakage
    const blocks = rawSse.split('\n\n').filter((b) => b.trim().length > 0);
    let fullContent = '';
    for (const block of blocks) {
      expect(block.startsWith('data: ')).toBe(true);
      const data = block.slice(6);
      if (data === '[DONE]') {
        continue;
      }
      const parsed = JSON.parse(data) as { choices: Array<{ delta: { content?: string } }> };
      const deltaText = parsed.choices[0]?.delta.content ?? '';
      expect(findPiiMatches(deltaText)).toEqual([]);
      expect(deltaText).not.toContain('alice.ops');
      expect(deltaText).not.toContain('quill-local.io');
      expect(deltaText).not.toContain('123-');
      expect(deltaText).not.toContain('45-6789');
      expect(deltaText).not.toContain('4111');
      fullContent += deltaText;
    }

    expect(fullContent).toBe('Reach [REDACTED] or SSN [REDACTED] and card [REDACTED].');
  });

  it('handles upstream connection failures, timeouts, and malformed SSE streams safely', async () => {
    // 1. Connection failure (closed local port) -> 502 UPSTREAM_UNAVAILABLE
    const tempSrv = createServer();
    const closedPort = await listenHttpServer(tempSrv);
    await closeHttpServer(tempSrv);

    const connFailProvider = new OllamaProvider({
      baseUrl: `http://127.0.0.1:${closedPort}/v1`,
      timeoutMs: 2000,
    });
    const connFailGw = createStreamingGuardrailServer({
      provider: connFailProvider,
      silentLogs: true,
    });
    activeGateways.push(connFailGw);
    const connFailGwPort = await connFailGw.listen(0, '127.0.0.1');

    const connRes = await fetch(`http://127.0.0.1:${connFailGwPort}/v1/chat/completions`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        model: 'llama3.2:1b',
        stream: true,
        messages: [{ role: 'user', content: 'Hello' }],
      }),
    });
    expect(connRes.status).toBe(502);
    const connJson = (await connRes.json()) as { error: { code: string; message: string } };
    expect(connJson.error.code).toBe('UPSTREAM_UNAVAILABLE');
    expect(JSON.stringify(connJson)).not.toContain(String(closedPort));

    // 2. Upstream initial timeout -> 504 UPSTREAM_TIMEOUT
    const hungUpstream = createServer((_req, _res) => {
      // Intentionally never respond
    });
    activeUpstreams.push(hungUpstream);
    const hungPort = await listenHttpServer(hungUpstream);

    const timeoutProvider = new OllamaProvider({
      baseUrl: `http://127.0.0.1:${hungPort}/v1`,
      timeoutMs: 80,
    });
    const timeoutGw = createStreamingGuardrailServer({
      provider: timeoutProvider,
      silentLogs: true,
    });
    activeGateways.push(timeoutGw);
    const timeoutGwPort = await timeoutGw.listen(0, '127.0.0.1');

    const timeoutRes = await fetch(`http://127.0.0.1:${timeoutGwPort}/v1/chat/completions`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        model: 'llama3.2:1b',
        stream: true,
        messages: [{ role: 'user', content: 'Hello' }],
      }),
    });
    expect(timeoutRes.status).toBe(504);
    const timeoutJson = (await timeoutRes.json()) as { error: { code: string } };
    expect(timeoutJson.error.code).toBe('UPSTREAM_TIMEOUT');

    // 3. Malformed mid-stream SSE payload -> flushes safe buffer + UPSTREAM_STREAM_ERROR + [DONE]
    const malformedUpstream = createServer((_req, res) => {
      res.writeHead(200, { 'content-type': 'text/event-stream' });
      res.write(
        `data: ${JSON.stringify({
          id: 'chatcmpl-bad',
          created: 1769904100,
          model: 'llama3.2:1b',
          choices: [
            {
              index: 0,
              delta: { role: 'assistant', content: 'Safe prefix john@gmail.com' },
              finish_reason: null,
            },
          ],
        })}\n\n`,
      );
      res.end('data: {CORRUPTED_JSON_PAYLOAD\n\n');
    });
    activeUpstreams.push(malformedUpstream);
    const malformedPort = await listenHttpServer(malformedUpstream);

    const malformedProvider = new OllamaProvider({
      baseUrl: `http://127.0.0.1:${malformedPort}/v1`,
      timeoutMs: 2000,
    });
    const malformedGw = createStreamingGuardrailServer({
      provider: malformedProvider,
      silentLogs: true,
    });
    activeGateways.push(malformedGw);
    const malformedGwPort = await malformedGw.listen(0, '127.0.0.1');

    const malformedRes = await fetch(`http://127.0.0.1:${malformedGwPort}/v1/chat/completions`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        model: 'llama3.2:1b',
        stream: true,
        messages: [{ role: 'user', content: 'Hello' }],
      }),
    });
    expect(malformedRes.status).toBe(200);
    const malformedRaw = await malformedRes.text();
    expect(malformedRaw).not.toContain('john@gmail.com');
    expect(malformedRaw).toContain('UPSTREAM_STREAM_ERROR');
    expect(malformedRaw.endsWith('data: [DONE]\n\n')).toBe(true);

    const malformedBlocks = malformedRaw.split('\n\n').filter((b) => b.trim().length > 0);
    let reconstructedSafeText = '';
    for (const block of malformedBlocks) {
      const payload = block.slice(6);
      if (payload === '[DONE]') {
        continue;
      }
      const parsedFrame = JSON.parse(payload) as {
        choices?: Array<{ delta?: { content?: string } }>;
      };
      const deltaContent = parsedFrame.choices?.[0]?.delta?.content ?? '';
      expect(findPiiMatches(deltaContent)).toEqual([]);
      reconstructedSafeText += deltaContent;
    }
    expect(reconstructedSafeText).toBe('Safe prefix [REDACTED]');
  });

  it('aborts upstream Ollama HTTP generation immediately when downstream client disconnects', async () => {
    const upstreamState = { socketClosed: false };

    const slowOllama = createServer((req, res) => {
      res.writeHead(200, { 'content-type': 'text/event-stream' });
      res.write(
        `data: ${JSON.stringify({
          id: 'chatcmpl-cancel',
          created: 1769904100,
          model: 'llama3.2:1b',
          choices: [
            { index: 0, delta: { role: 'assistant', content: 'Token 1 ' }, finish_reason: null },
          ],
        })}\n\n`,
      );

      const interval = setInterval(() => {
        if (!res.writableEnded && !res.destroyed) {
          res.write(
            `data: ${JSON.stringify({
              id: 'chatcmpl-cancel',
              created: 1769904100,
              model: 'llama3.2:1b',
              choices: [{ index: 0, delta: { content: 'More tokens ' }, finish_reason: null }],
            })}\n\n`,
          );
        }
      }, 25);

      const markClosed = (): void => {
        upstreamState.socketClosed = true;
        clearInterval(interval);
      };
      req.once('close', markClosed);
      res.once('close', markClosed);
    });
    activeUpstreams.push(slowOllama);
    const slowPort = await listenHttpServer(slowOllama);

    const provider = new OllamaProvider({
      baseUrl: `http://127.0.0.1:${slowPort}/v1`,
      timeoutMs: 5000,
    });
    const gateway = createStreamingGuardrailServer({ provider, silentLogs: true });
    activeGateways.push(gateway);
    const gwPort = await gateway.listen(0, '127.0.0.1');

    const clientAc = new AbortController();
    const res = await fetch(`http://127.0.0.1:${gwPort}/v1/chat/completions`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        model: 'llama3.2:1b',
        stream: true,
        messages: [{ role: 'user', content: 'Stream until cancelled' }],
      }),
      signal: clientAc.signal,
    });

    const reader = res.body?.getReader();
    await reader?.read();
    clientAc.abort();

    const deadline = Date.now() + 2000;
    while (!upstreamState.socketClosed && Date.now() < deadline) {
      await new Promise((r) => setTimeout(r, 25));
    }
    expect(upstreamState.socketClosed).toBe(true);
  });

  describe.runIf(process.env['OLLAMA_LIVE_TEST'] === 'true')(
    'Live Local Ollama End-to-End Streaming Verification (Opt-In)',
    () => {
      it('streams from live local Ollama and redacts PII in real time', async () => {
        const liveModel = process.env['OLLAMA_MODEL'] ?? DEFAULT_OLLAMA_MODEL;
        const liveBaseUrl = process.env['OLLAMA_BASE_URL'] ?? DEFAULT_OLLAMA_BASE_URL;
        const provider = new OllamaProvider({
          baseUrl: liveBaseUrl,
          defaultModel: liveModel,
          timeoutMs: 30_000,
        });
        const gateway = createStreamingGuardrailServer({ provider, silentLogs: true });
        activeGateways.push(gateway);
        const gwPort = await gateway.listen(0, '127.0.0.1');

        const res = await fetch(`http://127.0.0.1:${gwPort}/v1/chat/completions`, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({
            model: liveModel,
            stream: true,
            temperature: 0,
            max_tokens: 64,
            messages: [
              {
                role: 'user',
                content:
                  'Reply with this exact sentence only: Contact john.doe@example.com or SSN 123-45-6789.',
              },
            ],
          }),
        });

        expect(res.status).toBe(200);
        const rawText = await res.text();
        expect(rawText.endsWith('data: [DONE]\n\n')).toBe(true);
        expect(rawText).not.toContain('john.doe@example.com');
        expect(rawText).not.toContain('123-45-6789');
      }, 30_000);
    },
  );
});
