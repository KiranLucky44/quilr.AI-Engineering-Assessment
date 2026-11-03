import { realpathSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { MockLLMProvider } from './providers/mock-llm.provider.js';
import { createStreamingGuardrailServer, type StreamingGatewayHandle } from './server.js';

export {
  findPiiMatches,
  isValidUsSsnDigits,
  MAX_CARD_LENGTH,
  MAX_EMAIL_LENGTH,
  MAX_HOLD_BUFFER_LENGTH,
  MAX_SSN_LENGTH,
  passesLuhnChecksum,
  REDACTION_TOKEN,
} from './streaming/pii-patterns.js';
export { StreamingRedactor, type StreamingRedactorStats } from './streaming/streaming-redactor.js';
export {
  encodeCompletionChunkSse,
  encodeSseDone,
  parseUpstreamSseEvents,
} from './streaming/sse-encoder.js';
export {
  type ChatCompletionStreamRequest,
  type LLMStreamProvider,
  type NormalizedCompletionDelta,
} from './providers/llm-provider.interface.js';
export { MockLLMProvider, type MockLLMProviderOptions } from './providers/mock-llm.provider.js';
export {
  createStreamingGuardrailServer,
  type StreamingGatewayHandle,
  type StreamingGatewayOptions,
} from './server.js';

export async function startStreamingGuardrailFromEnv(
  env: Readonly<Record<string, string | undefined>> = process.env,
): Promise<StreamingGatewayHandle> {
  const host = env['STREAMING_GATEWAY_HOST']?.trim() || '127.0.0.1';
  const port = Number.parseInt(env['STREAMING_GATEWAY_PORT'] ?? '4020', 10);
  const maxBodyBytes = Number.parseInt(env['STREAMING_MAX_BODY_BYTES'] ?? '131072', 10);
  const chunkDelayMs = Number.parseInt(env['MOCK_CHUNK_DELAY_MS'] ?? '10', 10);

  const provider = new MockLLMProvider({
    chunkDelayMs: Number.isFinite(chunkDelayMs) && chunkDelayMs >= 0 ? chunkDelayMs : 10,
  });

  const gateway = createStreamingGuardrailServer({
    provider,
    maxBodyBytes: Number.isFinite(maxBodyBytes) && maxBodyBytes > 0 ? maxBodyBytes : 131072,
  });

  const boundPort = await gateway.listen(
    Number.isFinite(port) && port >= 0 && port <= 65535 ? port : 4020,
    host,
  );

  process.stderr.write(
    `${JSON.stringify({
      timestamp: new Date().toISOString(),
      level: 'info',
      component: 'llm-streaming-guardrail',
      message: `Streaming PII Redaction Gateway listening on http://${host}:${boundPort}/v1/chat/completions`,
    })}\n`,
  );

  return gateway;
}

function isExecutedDirectly(): boolean {
  const entryArg = process.argv[1];
  if (!entryArg) {
    return false;
  }
  try {
    return realpathSync(entryArg) === realpathSync(fileURLToPath(import.meta.url));
  } catch {
    return false;
  }
}

if (isExecutedDirectly()) {
  startStreamingGuardrailFromEnv()
    .then((gateway) => {
      const handleSignal = (signal: string): void => {
        process.stderr.write(
          `${JSON.stringify({
            timestamp: new Date().toISOString(),
            level: 'info',
            component: 'llm-streaming-guardrail',
            message: `Received ${signal}, shutting down streaming gateway`,
          })}\n`,
        );
        void gateway.close().finally(() => {
          process.exit(0);
        });
      };

      process.once('SIGINT', () => {
        handleSignal('SIGINT');
      });
      process.once('SIGTERM', () => {
        handleSignal('SIGTERM');
      });
    })
    .catch((err: unknown) => {
      process.stderr.write(
        `${JSON.stringify({
          timestamp: new Date().toISOString(),
          level: 'error',
          component: 'llm-streaming-guardrail',
          message: 'Fatal startup failure',
          errorName: err instanceof Error ? err.name : 'UnknownError',
        })}\n`,
      );
      process.exit(1);
    });
}
