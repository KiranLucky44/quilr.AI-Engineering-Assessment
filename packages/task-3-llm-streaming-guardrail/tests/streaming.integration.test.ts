import { EventEmitter } from 'node:events';
import { request as httpRequest, type IncomingMessage, type ServerResponse } from 'node:http';
import { Readable } from 'node:stream';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { MockLLMProvider } from '../src/providers/mock-llm.provider.js';
import {
  createStreamingGuardrailServer,
  readBoundedBody,
  type StreamingGatewayHandle,
} from '../src/server.js';
import { findPiiMatches } from '../src/streaming/pii-patterns.js';
import { parseUpstreamSseEvents, writeSseWithBackpressure } from '../src/streaming/sse-encoder.js';

interface ParsedSseResult {
  readonly rawText: string;
  readonly jsonEvents: Array<Record<string, unknown>>;
  readonly concatenatedContent: string;
  readonly sawDoneMarker: boolean;
}

function parseSseText(rawText: string): ParsedSseResult {
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

async function collectSseResponse(response: Response): Promise<ParsedSseResult> {
  const rawText = await response.text();
  return parseSseText(rawText);
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

    // Verify OpenAI chunk metadata fields remain intact and inspect EVERY individual SSE event for raw or partial PII leakage
    const forbiddenSseFragments = [
      'synthetic.customer',
      'quill-demo',
      '123-',
      '45-6789',
      '4111',
      '1111',
    ];
    for (const evt of sse.jsonEvents) {
      expect(evt['object']).toBe('chat.completion.chunk');
      expect(evt['model']).toBe('quill-mock-gpt');
      expect(evt['system_fingerprint']).toBe('fp_quill_guardrail_v1');

      const serializedEvent = JSON.stringify(evt);
      const choices = evt['choices'] as Array<{ delta?: { content?: string } }> | undefined;
      const deltaContent = choices?.[0]?.delta?.content ?? '';
      expect(findPiiMatches(deltaContent)).toEqual([]);
      for (const frag of forbiddenSseFragments) {
        expect(deltaContent).not.toContain(frag);
        expect(serializedEvent).not.toContain(frag);
      }
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

  it('rejects invalid requests and distinguishes MALFORMED_JSON from VALIDATION_ERROR', async () => {
    const provider = new MockLLMProvider({ chunkDelayMs: 0 });
    const streamSpy = vi.spyOn(provider, 'streamChatCompletion');
    const gateway = createStreamingGuardrailServer({ provider, silentLogs: true });
    activeServers.push(gateway);
    const port = await gateway.listen(0, '127.0.0.1');
    const url = `http://127.0.0.1:${port}/v1/chat/completions`;

    const wrongMethod = await fetch(url, { method: 'GET' });
    expect(wrongMethod.status).toBe(405);

    const missingType = await fetch(url, { method: 'POST', body: '{}' });
    expect(missingType.status).toBe(415);

    const wrongType = await fetch(url, {
      method: 'POST',
      headers: { 'content-type': 'text/plain' },
      body: '{}',
    });
    expect(wrongType.status).toBe(415);

    const badCharset = await fetch(url, {
      method: 'POST',
      headers: { 'content-type': 'application/json; charset=iso-8859-1' },
      body: '{}',
    });
    expect(badCharset.status).toBe(415);

    // Schema validation error (valid JSON, invalid schema: stream: false)
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
    const streamFalseJson = (await streamFalse.json()) as {
      error: { code: string; message: string };
    };
    expect(streamFalseJson.error.code).toBe('VALIDATION_ERROR');
    expect(streamFalseJson.error.message).toContain('stream');

    // Schema validation error (valid JSON, empty messages array)
    const emptyMessages = await fetch(url, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        model: 'quill-mock-gpt',
        stream: true,
        messages: [],
      }),
    });
    expect(emptyMessages.status).toBe(400);
    const emptyMessagesJson = (await emptyMessages.json()) as {
      error: { code: string; message: string };
    };
    expect(emptyMessagesJson.error.code).toBe('VALIDATION_ERROR');

    // Malformed JSON error (unparseable JSON syntax)
    const badJson = await fetch(url, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: '{bad',
    });
    expect(badJson.status).toBe(400);
    const badJsonBody = (await badJson.json()) as { error: { code: string; message: string } };
    expect(badJsonBody.error.code).toBe('MALFORMED_JSON');
    expect(badJsonBody.error.message).toContain('Malformed JSON');

    // Empty body error -> MALFORMED_JSON
    const emptyBody = await fetch(url, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: '',
    });
    expect(emptyBody.status).toBe(400);
    const emptyBodyJson = (await emptyBody.json()) as { error: { code: string; message: string } };
    expect(emptyBodyJson.error.code).toBe('MALFORMED_JSON');
    expect(emptyBodyJson.error.message).toContain('empty');

    // Invalid UTF-8 bytes (e.g. UTF-16LE BOM 0xFF 0xFE) -> INVALID_UTF8
    const invalidUtf8 = await fetch(url, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: new Uint8Array([0xff, 0xfe, 0x7b, 0x00, 0x7d, 0x00]),
    });
    expect(invalidUtf8.status).toBe(400);
    const invalidUtf8Json = (await invalidUtf8.json()) as {
      error: { code: string; message: string };
    };
    expect(invalidUtf8Json.error.code).toBe('INVALID_UTF8');

    // None of the invalid requests should ever invoke the upstream mock provider
    expect(streamSpy).not.toHaveBeenCalled();
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

  it('pauses SSE writes when socket buffer is saturated and resumes on drain or cancels on abort', async () => {
    class MockBackpressureResponse extends EventEmitter {
      public writableEnded = false;
      public destroyed = false;
      public saturateWrites = true;
      public writtenFrames: string[] = [];

      public write(chunk: string): boolean {
        this.writtenFrames.push(chunk);
        return !this.saturateWrites;
      }
    }

    // 1. Pauses until 'drain' event fires
    const mockResDrain = new MockBackpressureResponse();
    const drainAc = new AbortController();
    let drainSettled = false;

    const writePromise = writeSseWithBackpressure(
      mockResDrain as unknown as ServerResponse,
      'data: {"ok":true}\n\n',
      drainAc.signal,
    ).then((result) => {
      drainSettled = true;
      return result;
    });

    await Promise.resolve();
    expect(drainSettled).toBe(false);
    expect(mockResDrain.listenerCount('drain')).toBe(1);

    mockResDrain.emit('drain');
    const drainResult = await writePromise;
    expect(drainResult).toBe(true);
    expect(drainSettled).toBe(true);
    expect(mockResDrain.listenerCount('drain')).toBe(0);
    expect(mockResDrain.listenerCount('close')).toBe(0);
    expect(mockResDrain.listenerCount('error')).toBe(0);

    // 2. Resolves false cleanly and removes listeners if aborted while backpressured
    const mockResAbort = new MockBackpressureResponse();
    const abortAc = new AbortController();
    const abortWritePromise = writeSseWithBackpressure(
      mockResAbort as unknown as ServerResponse,
      'data: {"ok":true}\n\n',
      abortAc.signal,
    );

    abortAc.abort();
    const abortResult = await abortWritePromise;
    expect(abortResult).toBe(false);
    expect(mockResAbort.listenerCount('drain')).toBe(0);
    expect(mockResAbort.listenerCount('close')).toBe(0);
    expect(mockResAbort.listenerCount('error')).toBe(0);
  });

  it('reads chunked HTTP request bodies split mid-UTF8-codepoint, tolerates UTF-8 BOM, and delivers parsed request to MockLLMProvider', async () => {
    const provider = new MockLLMProvider({ chunkDelayMs: 0 });
    const streamSpy = vi.spyOn(provider, 'streamChatCompletion');
    const gateway = createStreamingGuardrailServer({ provider, silentLogs: true });
    activeServers.push(gateway);
    const port = await gateway.listen(0, '127.0.0.1');

    // 1. Fragmented Transfer-Encoding: chunked request splitting multi-byte UTF-8 ('José 🔐 東京') across byte chunks
    const promptWithMultibyteUtf8 = 'Verify account for José 🔐 東京';
    const jsonPayload = JSON.stringify({
      model: 'quill-mock-gpt',
      stream: true,
      mock_scenario: 'email_three_chunk',
      temperature: 0.25,
      max_tokens: 512,
      messages: [{ role: 'user', content: promptWithMultibyteUtf8 }],
    });
    const rawBuffer = Buffer.from(jsonPayload, 'utf8');

    const chunkedResult = await new Promise<{ statusCode: number; bodyText: string }>(
      (resolvePromise, rejectPromise) => {
        const req = httpRequest(
          {
            hostname: '127.0.0.1',
            port,
            path: '/v1/chat/completions',
            method: 'POST',
            headers: {
              'content-type': 'APPLICATION/JSON; charset="UTF-8"',
              'transfer-encoding': 'chunked',
            },
          },
          (res) => {
            const resChunks: Buffer[] = [];
            res.on('data', (c: Buffer) => resChunks.push(c));
            res.on('end', () => {
              resolvePromise({
                statusCode: res.statusCode ?? 0,
                bodyText: Buffer.concat(resChunks).toString('utf8'),
              });
            });
            res.on('error', rejectPromise);
          },
        );
        req.on('error', rejectPromise);

        // Slice in 7-byte increments so multi-byte UTF-8 sequences (2, 3, and 4 bytes) split across chunks
        let offset = 0;
        const step = (): void => {
          if (offset >= rawBuffer.length) {
            req.end();
            return;
          }
          const nextOffset = Math.min(rawBuffer.length, offset + 7);
          req.write(rawBuffer.subarray(offset, nextOffset));
          offset = nextOffset;
          setTimeout(step, 1);
        };
        step();
      },
    );

    expect(chunkedResult.statusCode).toBe(200);
    const chunkedSse = parseSseText(chunkedResult.bodyText);
    expect(chunkedSse.sawDoneMarker).toBe(true);
    expect(chunkedSse.concatenatedContent).toBe('Contact [REDACTED] regarding the request.');
    expect(chunkedResult.bodyText.endsWith('data: [DONE]\n\n')).toBe(true);
    expect(streamSpy).toHaveBeenCalledTimes(1);
    expect(streamSpy.mock.calls[0]?.[0]).toEqual({
      model: 'quill-mock-gpt',
      stream: true,
      mock_scenario: 'email_three_chunk',
      temperature: 0.25,
      max_tokens: 512,
      messages: [{ role: 'user', content: promptWithMultibyteUtf8 }],
    });

    // 2. Valid UTF-8 JSON body prefixed with UTF-8 BOM (0xEF 0xBB 0xBF, common on Windows PowerShell)
    const bomPrefix = Buffer.from([0xef, 0xbb, 0xbf]);
    const bomPayload = Buffer.concat([bomPrefix, rawBuffer]);
    const bomRes = await fetch(`http://127.0.0.1:${port}/v1/chat/completions`, {
      method: 'POST',
      headers: { 'content-type': 'application/json; charset=utf-8' },
      body: bomPayload,
    });
    expect(bomRes.status).toBe(200);
    const bomSse = await collectSseResponse(bomRes);
    expect(bomSse.sawDoneMarker).toBe(true);
    expect(bomSse.concatenatedContent).toBe('Contact [REDACTED] regarding the request.');
    expect(streamSpy).toHaveBeenCalledTimes(2);
    expect(provider.emittedChunkCount).toBeGreaterThanOrEqual(6);
  });

  it('guards against consuming the HTTP request body stream twice', async () => {
    const fakeStream = Readable.from([Buffer.from('{"model":"quill-mock-gpt"}', 'utf8')]);
    Object.assign(fakeStream, { headers: {}, complete: true });
    const req = fakeStream as unknown as IncomingMessage;

    const firstRead = await readBoundedBody(req, 4096);
    expect(firstRead).toBe('{"model":"quill-mock-gpt"}');

    await expect(readBoundedBody(req, 4096)).rejects.toThrow(/already been consumed/i);
  });
});
