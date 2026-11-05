import { realpathSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import {
  createConfiguredStreamProvider,
  loadDotEnvIntoProcessEnv,
  loadStreamingGatewayConfig,
} from './config.js';
import { createStreamingGuardrailServer, type StreamingGatewayHandle } from './server.js';

export {
  createConfiguredStreamProvider,
  loadDotEnvIntoProcessEnv,
  loadStreamingGatewayConfig,
  readDotEnvFiles,
  type LoadStreamingConfigOptions,
  type StreamingGatewayConfig,
  type StreamingProviderMode,
} from './config.js';
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
  DEFAULT_OLLAMA_BASE_URL,
  DEFAULT_OLLAMA_MODEL,
  DEFAULT_OLLAMA_TIMEOUT_MS,
  OllamaProvider,
  parseOpenAICompatibleChunkJson,
  UpstreamStreamProviderError,
  type OllamaProviderOptions,
  type UpstreamErrorKind,
} from './providers/ollama.provider.js';
export {
  createStreamingGuardrailServer,
  type StreamingGatewayHandle,
  type StreamingGatewayOptions,
} from './server.js';

export async function startStreamingGuardrailFromEnv(
  env?: Readonly<Record<string, string | undefined>>,
): Promise<StreamingGatewayHandle> {
  if (env === undefined) {
    loadDotEnvIntoProcessEnv();
  }
  const config = loadStreamingGatewayConfig(env);
  const provider = createConfiguredStreamProvider(config);

  const gateway = createStreamingGuardrailServer({
    provider,
    maxBodyBytes: config.maxBodyBytes,
  });

  const boundPort = await gateway.listen(config.port, config.host);

  process.stderr.write(
    `${JSON.stringify({
      timestamp: new Date().toISOString(),
      level: 'info',
      component: 'llm-streaming-guardrail',
      message: `Streaming PII Redaction Gateway listening on http://${config.host}:${boundPort}/v1/chat/completions`,
      provider: provider.providerName,
      ...(config.providerMode === 'ollama' ? { ollamaModel: config.ollamaModel } : {}),
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
      const errorCode =
        typeof err === 'object' &&
        err !== null &&
        'code' in err &&
        (typeof err.code === 'string' || typeof err.code === 'number')
          ? String(err.code)
          : undefined;
      const errorMessage = err instanceof Error ? err.message : 'Unknown startup error';
      const hint =
        errorCode === 'EADDRINUSE'
          ? 'Target TCP port (4020) is already occupied by another process. Terminate the existing instance before restarting Task 3.'
          : undefined;

      process.stderr.write(
        `${JSON.stringify({
          timestamp: new Date().toISOString(),
          level: 'error',
          component: 'llm-streaming-guardrail',
          message: 'Fatal startup failure in Task 3 Streaming Gateway',
          errorName: err instanceof Error ? err.name : 'UnknownError',
          ...(errorCode !== undefined ? { errorCode } : {}),
          errorMessage,
          ...(hint !== undefined ? { hint } : {}),
        })}\n`,
      );
      process.exit(1);
    });
}
