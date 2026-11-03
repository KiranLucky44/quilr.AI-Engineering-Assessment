import { afterEach, describe, expect, it } from 'vitest';
import { MockLLMProvider } from '../src/providers/mock-llm.provider.js';
import { createStreamingGuardrailServer, type StreamingGatewayHandle } from '../src/server.js';
import { parseUpstreamSseEvents } from '../src/streaming/sse-encoder.js';

interface ParsedSseResult {
  readonly rawText: string;
  readonly jsonEvents: Array<Record<string, unknown>>;
  readonly concatenatedContent: string;
  readonly sawDoneMarker: boolean;
}

async function collectSseResponse(response: Response): Promise<ParsedSseResult> {
  const rawText = await response.text();
  const blocks = rawText.split('\n\n').filter((b) => b.trim().length > 0);
  const jsonEvents: Array<Record<string, unknown>> = [];
  let concatenatedContent = '';
  let sawDoneMarker = false;

  for (const block of blocks) {
    expect(block.startsWith('data: ')).toBe(true);
    const payload = block.slice(6);
    if (payload === '[DONE]') {
      sawDoneMarker = true;
      continue;
    }
    const parsed = JSON.parse(payload) as {
      choices?: Array<{ delta?: { content?: string } }>;
    } & Record<string, unknown>;
    jsonEvents.push(parsed);
    const content = parsed.choices?.[0]?.delta?.content;
    if (typeof content === 'string') {
      concatenatedContent += content;
    }
  }

  return { rawText, jsonEvents, concatenatedContent, sawDoneMarker };
}

describe('Task 3 Streaming PII Redaction Gateway HTTP/SSE Integration', () => {
  const activeServers: StreamingGatewayHandle[] = [];

  afterEach(async () => {
    while (activeServers.length > 0) {
      const srv = activeServers.pop();
      if (srv) {
        await srv.close();
      }
    }
  });

  it('streams valid OpenAI-compatible SSE chunks, redacts all 3 PII types across boundaries, and ends with [DONE]', async () => {
    const provider = new MockLLMProvider({ chunkDelayMs: 1 });
    const gateway = createStreamingGuardrailServer({ provider, silentLogs: true });
    activeServers.push(gateway);
    const port = await gateway.listen(0, '127.0.0.1');

    const res = await fetch(`http://127.0.0.1:${port}/v1/chat/completions`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        model: 'quill-mock-gpt',
        stream: true,
        messages: [{ role: 'user', content: 'Show demo synthetic account details' }],
      }),
    });

    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toContain('text/event-stream');

    const sse = await collectSseResponse(res);
    expect(sse.sawDoneMarker).toBe(true);
    expect(sse.rawText.endsWith('data: [DONE]\n\n')).toBe(true);

    // Verify no raw sensitive value EVER appeared anywhere in the raw wire bytes
    expect(sse.rawText).not.toContain('synthetic.customer@quill-demo.example');
    expect(sse.rawText).not.toContain('123-45-6789');
    expect(sse.rawText).not.toContain('4111 1111 1111 1111');

    expect(sse.concatenatedContent).toBe(
      'Hello! For billing support, reach out to [REDACTED] regarding account SSN [REDACTED] and test payment card [REDACTED]. Have a wonderful day!',
    );

    // Verify OpenAI chunk metadata fields remain intact
    for (const evt of sse.jsonEvents) {
      expect(evt['object']).toBe('chat.completion.chunk');
      expect(evt['model']).toBe('quill-mock-gpt');
      expect(evt['system_fingerprint']).toBe('fp_quill_guardrail_v1');
    }
  });

  it('cancels upstream provider generation promptly when the HTTP client disconnects mid-stream', async () => {
    let abortObserved = false;
    const slowChunks = Array.from({ length: 40 }, (_, i) => `Chunk ${i} safe text. `);
    const provider = new MockLLMProvider({
      chunkDelayMs: 25,
      customChunks: slowChunks,
      onAbort: () => {
        abortObserved = true;
      },
    });

    const gateway = createStreamingGuardrailServer({ provider, silentLogs: true });
    activeServers.push(gateway);
    const port = await gateway.listen(0, '127.0.0.1');

    const controller = new AbortController();
    const response = await fetch(`http://127.0.0.1:${port}/v1/chat/completions`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        model: 'quill-mock-gpt',
        stream: true,
        messages: [{ role: 'user', content: 'Stream long output' }],
      }),
      signal: controller.signal,
    });

    const reader = response.body?.getReader();
    expect(reader).toBeDefined();
    await reader?.read();
    await reader?.read();

    // Client cancels request mid-stream
    controller.abort();

    await new Promise((r) => setTimeout(r, 80));
    expect(abortObserved).toBe(true);
    expect(provider.emittedChunkCount).toBeLessThan(slowChunks.length);
  });

  it('rejects invalid requests (stream: false, empty messages, malformed JSON, wrong method/content-type)', async () => {
    const gateway = createStreamingGuardrailServer({ silentLogs: true });
    activeServers.push(gateway);
    const port = await gateway.listen(0, '127.0.0.1');
    const url = `http://127.0.0.1:${port}/v1/chat/completions`;

    const wrongMethod = await fetch(url, { method: 'GET' });
    expect(wrongMethod.status).toBe(405);

    const wrongType = await fetch(url, {
      method: 'POST',
      headers: { 'content-type': 'text/plain' },
      body: '{}',
    });
    expect(wrongType.status).toBe(415);

    const streamFalse = await fetch(url, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        model: 'quill-mock-gpt',
        stream: false,
        messages: [{ role: 'user', content: 'hi' }],
      }),
    });
    expect(streamFalse.status).toBe(400);

    const badJson = await fetch(url, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: '{bad',
    });
    expect(badJson.status).toBe(400);
  });

  it('handles mid-stream upstream errors gracefully without leaking internal stack traces', async () => {
    const provider = new MockLLMProvider({ chunkDelayMs: 0 });
    const gateway = createStreamingGuardrailServer({ provider, silentLogs: true });
    activeServers.push(gateway);
    const port = await gateway.listen(0, '127.0.0.1');

    const res = await fetch(`http://127.0.0.1:${port}/v1/chat/completions`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        model: 'quill-mock-gpt',
        stream: true,
        mock_scenario: 'upstream_midstream_error',
        messages: [{ role: 'user', content: 'Trigger upstream failure' }],
      }),
    });

    const rawText = await res.text();
    expect(rawText).toContain('UPSTREAM_STREAM_ERROR');
    expect(rawText).toContain('data: [DONE]\n\n');
    expect(rawText).not.toContain('/internal/provider.ts');
  });

  it('parses partial upstream SSE event frames split across arbitrary byte chunks', async () => {
    async function* splitFrames(): AsyncGenerator<string> {
      await Promise.resolve();
      yield 'data: {"id":"1","choices":[{"delta":';
      yield '{"content":"hel"}}]}\n';
      yield '\ndata: {"id":"1","choices":[{"delta":{"content":"lo"}}]}\n\ndata: [DO';
      yield 'NE]\n\n';
    }

    const events: string[] = [];
    const ac = new AbortController();
    for await (const evt of parseUpstreamSseEvents(splitFrames(), ac.signal)) {
      events.push(evt);
    }

    expect(events).toHaveLength(2);
    expect(JSON.parse(events[0] ?? '{}') as Record<string, unknown>).toHaveProperty('id', '1');
  });
});
