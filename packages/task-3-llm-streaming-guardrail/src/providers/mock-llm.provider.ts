import type {
  ChatCompletionStreamRequest,
  LLMStreamProvider,
  MockScenarioName,
  NormalizedCompletionDelta,
} from './llm-provider.interface.js';

export interface MockLLMProviderOptions {
  readonly chunkDelayMs?: number;
  readonly customChunks?: readonly string[];
  readonly fixedCreatedTimestamp?: number;
  readonly onAbort?: () => void;
}

const SCENARIO_CHUNKS: Readonly<
  Record<Exclude<MockScenarioName, 'long_stream' | 'upstream_midstream_error'>, readonly string[]>
> = {
  // Synthetic demo containing all 3 PII types split across awkward token boundaries
  default_demo: [
    'Hello! For billing support, reach out to synthetic.customer@',
    'quill-demo.',
    'example regarding account SSN 123-',
    '45-6789 and test payment card 4111 ',
    '1111 1111 ',
    '1111. Have a wonderful day!',
  ],
  email_three_chunk: ['Contact john@', 'gmail.', 'com regarding the request.'],
  ssn_split: ['Verified synthetic taxpayer ID 123-', '45-', '6789 on file.'],
  card_split: ['Charged Visa 4111', '-1111-', '1111-1111 successfully.'],
};

function abortableDelay(delayMs: number, signal: AbortSignal): Promise<void> {
  if (delayMs <= 0) {
    return Promise.resolve();
  }
  if (signal.aborted) {
    return Promise.reject(new DOMException('Aborted', 'AbortError'));
  }

  return new Promise((resolvePromise, rejectPromise) => {
    const timer = setTimeout(() => {
      signal.removeEventListener('abort', onAbort);
      resolvePromise();
    }, delayMs);

    const onAbort = (): void => {
      clearTimeout(timer);
      rejectPromise(new DOMException('Aborted', 'AbortError'));
    };

    signal.addEventListener('abort', onAbort, { once: true });
  });
}

/**
 * Deterministic local mock LLM streaming provider.
 * Requires zero external network calls or paid API credentials.
 */
export class MockLLMProvider implements LLMStreamProvider {
  public readonly providerName = 'deterministic-mock-llm';
  private readonly chunkDelayMs: number;
  private readonly customChunks: readonly string[] | undefined;
  private readonly fixedCreatedTimestamp: number;
  private readonly onAbort: (() => void) | undefined;

  public emittedChunkCount = 0;
  public abortedStreamCount = 0;

  public constructor(options: MockLLMProviderOptions = {}) {
    this.chunkDelayMs = options.chunkDelayMs ?? 5;
    this.customChunks = options.customChunks;
    this.fixedCreatedTimestamp = options.fixedCreatedTimestamp ?? 1769904000;
    this.onAbort = options.onAbort;
  }

  public async *streamChatCompletion(
    request: ChatCompletionStreamRequest,
    signal: AbortSignal,
  ): AsyncGenerator<NormalizedCompletionDelta> {
    const completionId = 'chatcmpl_mock_deterministic_01';
    const systemFingerprint = 'fp_quill_guardrail_v1';

    const recordAbort = (): void => {
      this.abortedStreamCount += 1;
      this.onAbort?.();
    };

    if (signal.aborted) {
      recordAbort();
      return;
    }

    yield {
      id: completionId,
      created: this.fixedCreatedTimestamp,
      model: request.model,
      systemFingerprint,
      role: 'assistant',
      contentDelta: '',
      finishReason: null,
    };

    const scenario = request.mock_scenario ?? 'default_demo';

    if (scenario === 'upstream_midstream_error') {
      yield {
        id: completionId,
        created: this.fixedCreatedTimestamp,
        model: request.model,
        systemFingerprint,
        contentDelta: 'Starting response before upstream failure... ',
        finishReason: null,
      };
      throw new Error('Simulated upstream provider connection reset at /internal/provider.ts:88');
    }

    const chunks: readonly string[] =
      this.customChunks ??
      (scenario === 'long_stream'
        ? Array.from({ length: 200 }, (_, i) =>
            i === 100
              ? ' midstream contact alice@example.org and card 4111111111111111 '
              : `Segment ${i + 1}: routine operational telemetry looks nominal. `,
          )
        : SCENARIO_CHUNKS[scenario]);

    for (const textChunk of chunks) {
      try {
        await abortableDelay(this.chunkDelayMs, signal);
      } catch {
        recordAbort();
        return;
      }

      this.emittedChunkCount += 1;
      yield {
        id: completionId,
        created: this.fixedCreatedTimestamp,
        model: request.model,
        systemFingerprint,
        contentDelta: textChunk,
        finishReason: null,
      };
    }

    yield {
      id: completionId,
      created: this.fixedCreatedTimestamp,
      model: request.model,
      systemFingerprint,
      finishReason: 'stop',
    };
  }
}
