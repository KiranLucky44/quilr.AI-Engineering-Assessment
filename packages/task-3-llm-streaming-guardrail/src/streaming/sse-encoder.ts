import type { ServerResponse } from 'node:http';
import type { NormalizedCompletionDelta } from '../providers/llm-provider.interface.js';

export interface OpenAIChatCompletionChunkChoice {
  readonly index: number;
  readonly delta: {
    readonly role?: 'assistant';
    readonly content?: string;
  };
  readonly finish_reason: 'stop' | 'length' | null;
}

export interface OpenAIChatCompletionChunk {
  readonly id: string;
  readonly object: 'chat.completion.chunk';
  readonly created: number;
  readonly model: string;
  readonly system_fingerprint?: string;
  readonly choices: readonly [OpenAIChatCompletionChunkChoice];
}

export function encodeCompletionChunkSse(delta: NormalizedCompletionDelta): string {
  const deltaObject: { role?: 'assistant'; content?: string } = {};
  if (delta.role !== undefined) {
    deltaObject.role = delta.role;
  }
  if (delta.contentDelta !== undefined) {
    deltaObject.content = delta.contentDelta;
  }

  const chunkPayload: OpenAIChatCompletionChunk = {
    id: delta.id,
    object: 'chat.completion.chunk',
    created: delta.created,
    model: delta.model,
    ...(delta.systemFingerprint !== undefined
      ? { system_fingerprint: delta.systemFingerprint }
      : {}),
    choices: [
      {
        index: 0,
        delta: deltaObject,
        finish_reason: delta.finishReason ?? null,
      },
    ],
  };

  return `data: ${JSON.stringify(chunkPayload)}\n\n`;
}

export function encodeSseErrorEvent(code: string, message: string, requestId: string): string {
  const payload = {
    error: {
      code,
      message,
      request_id: requestId,
    },
  };
  return `data: ${JSON.stringify(payload)}\n\n`;
}

export function encodeSseDone(): string {
  return 'data: [DONE]\n\n';
}

/**
 * Writes an SSE frame to an HTTP response while respecting Node.js writable stream backpressure.
 */
export async function writeSseWithBackpressure(
  res: ServerResponse,
  frame: string,
  signal: AbortSignal,
): Promise<boolean> {
  if (signal.aborted || res.writableEnded || res.destroyed) {
    return false;
  }

  const canContinue = res.write(frame);
  if (canContinue) {
    return true;
  }

  return await new Promise<boolean>((resolvePromise) => {
    const onDrain = (): void => {
      cleanup();
      resolvePromise(true);
    };
    const onCloseOrAbort = (): void => {
      cleanup();
      resolvePromise(false);
    };
    const cleanup = (): void => {
      res.removeListener('drain', onDrain);
      res.removeListener('close', onCloseOrAbort);
      res.removeListener('error', onCloseOrAbort);
      signal.removeEventListener('abort', onCloseOrAbort);
    };

    res.once('drain', onDrain);
    res.once('close', onCloseOrAbort);
    res.once('error', onCloseOrAbort);
    signal.addEventListener('abort', onCloseOrAbort, { once: true });
  });
}

const MAX_SSE_EVENT_BUFFER_CHARS = 65_536;

/**
 * Incrementally parses raw byte/text chunks from an upstream OpenAI-compatible SSE stream,
 * handling arbitrary TCP frame boundaries across `data: ...` lines and `\n\n` separators.
 */
export async function* parseUpstreamSseEvents(
  byteStream: AsyncIterable<Uint8Array | string>,
  signal: AbortSignal,
): AsyncGenerator<string> {
  const decoder = new TextDecoder('utf-8');
  let buffer = '';

  for await (const rawChunk of byteStream) {
    if (signal.aborted) {
      return;
    }

    buffer += typeof rawChunk === 'string' ? rawChunk : decoder.decode(rawChunk, { stream: true });
    buffer = buffer.replace(/\r\n/g, '\n');

    let boundaryIdx = buffer.indexOf('\n\n');
    while (boundaryIdx !== -1) {
      const rawEventBlock = buffer.slice(0, boundaryIdx);
      buffer = buffer.slice(boundaryIdx + 2);

      const dataLines: string[] = [];
      for (const line of rawEventBlock.split('\n')) {
        const trimmedLine = line.trim();
        if (trimmedLine.length === 0 || trimmedLine.startsWith(':')) {
          continue;
        }
        if (line.startsWith('data:')) {
          dataLines.push(line.slice(5).trimStart());
        } else if (
          line.startsWith('event:') ||
          line.startsWith('id:') ||
          line.startsWith('retry:')
        ) {
          continue;
        } else {
          throw new Error('Malformed upstream SSE frame line.');
        }
      }

      if (dataLines.length > 0) {
        const joined = dataLines.join('\n');
        if (joined === '[DONE]') {
          return;
        }
        yield joined;
      }

      boundaryIdx = buffer.indexOf('\n\n');
    }

    if (buffer.length > MAX_SSE_EVENT_BUFFER_CHARS) {
      throw new Error('Upstream SSE event exceeded maximum frame buffer size.');
    }
  }

  if (signal.aborted) {
    return;
  }

  buffer += decoder.decode();
  const remainingLines = buffer
    .replace(/\r\n/g, '\n')
    .split('\n')
    .map((l) => l.trim())
    .filter((l) => l.length > 0 && !l.startsWith(':'));

  if (remainingLines.length > 0) {
    throw new Error('Truncated upstream SSE event frame at end of stream.');
  }
}
