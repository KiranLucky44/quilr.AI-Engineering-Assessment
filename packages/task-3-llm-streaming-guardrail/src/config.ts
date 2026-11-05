import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseEnv } from 'node:util';
import type { LLMStreamProvider } from './providers/llm-provider.interface.js';
import { MockLLMProvider } from './providers/mock-llm.provider.js';
import {
  DEFAULT_OLLAMA_BASE_URL,
  DEFAULT_OLLAMA_MODEL,
  DEFAULT_OLLAMA_TIMEOUT_MS,
  OllamaProvider,
} from './providers/ollama.provider.js';

export type StreamingProviderMode = 'mock' | 'ollama';

export interface StreamingGatewayConfig {
  readonly host: string;
  readonly port: number;
  readonly maxBodyBytes: number;
  readonly providerMode: StreamingProviderMode;
  readonly mockChunkDelayMs: number;
  readonly ollamaBaseUrl: string;
  readonly ollamaModel: string;
  readonly ollamaApiKey?: string;
  readonly ollamaTimeoutMs: number;
}

const PACKAGE_ROOT = fileURLToPath(new URL('..', import.meta.url));
const MONOREPO_ROOT_ENV_PATH = resolve(PACKAGE_ROOT, '..', '..', '.env');
const PACKAGE_ENV_PATH = resolve(PACKAGE_ROOT, '.env');

export function readDotEnvFiles(
  envFilePaths: readonly string[] = [MONOREPO_ROOT_ENV_PATH, PACKAGE_ENV_PATH],
): Record<string, string> {
  const merged: Record<string, string> = {};
  for (const filePath of envFilePaths) {
    if (!existsSync(filePath)) {
      continue;
    }
    const raw = readFileSync(filePath, 'utf8');
    const normalized = raw.startsWith('\uFEFF') ? raw.slice(1) : raw;
    const parsed = parseEnv(normalized);
    for (const [key, value] of Object.entries(parsed)) {
      if (value !== undefined) {
        merged[key] = value;
      }
    }
  }
  return merged;
}

export function loadDotEnvIntoProcessEnv(
  targetEnv: Record<string, string | undefined> = process.env,
  envFilePaths?: readonly string[],
): void {
  const fileValues = readDotEnvFiles(envFilePaths);
  for (const [key, value] of Object.entries(fileValues)) {
    if (targetEnv[key] === undefined) {
      targetEnv[key] = value;
    }
  }
}

export interface LoadStreamingConfigOptions {
  readonly envFilePaths?: readonly string[];
  readonly skipDotEnv?: boolean;
}

export function loadStreamingGatewayConfig(
  env?: Readonly<Record<string, string | undefined>>,
  options: LoadStreamingConfigOptions = {},
): StreamingGatewayConfig {
  const fileEnv =
    options.skipDotEnv || env !== undefined ? {} : readDotEnvFiles(options.envFilePaths);
  const sourceEnv: Readonly<Record<string, string | undefined>> = env ?? {
    ...fileEnv,
    ...process.env,
  };

  const host = sourceEnv['STREAMING_GATEWAY_HOST']?.trim() || '127.0.0.1';
  const rawPort = Number.parseInt(sourceEnv['STREAMING_GATEWAY_PORT'] ?? '4020', 10);
  const port = Number.isSafeInteger(rawPort) && rawPort >= 0 && rawPort <= 65535 ? rawPort : 4020;

  const rawMaxBody = Number.parseInt(sourceEnv['STREAMING_MAX_BODY_BYTES'] ?? '131072', 10);
  const maxBodyBytes = Number.isSafeInteger(rawMaxBody) && rawMaxBody > 0 ? rawMaxBody : 131072;

  const rawDelay = Number.parseInt(sourceEnv['MOCK_CHUNK_DELAY_MS'] ?? '10', 10);
  const mockChunkDelayMs = Number.isSafeInteger(rawDelay) && rawDelay >= 0 ? rawDelay : 10;

  const rawProvider = sourceEnv['LLM_PROVIDER']?.trim().toLowerCase();
  let providerMode: StreamingProviderMode = 'mock';
  if (rawProvider === undefined || rawProvider === '' || rawProvider === 'mock') {
    providerMode = 'mock';
  } else if (rawProvider === 'ollama') {
    providerMode = 'ollama';
  } else {
    throw new Error(`Invalid LLM_PROVIDER "${rawProvider}". Supported values: "mock" or "ollama".`);
  }

  const ollamaBaseUrl = sourceEnv['OLLAMA_BASE_URL']?.trim() || DEFAULT_OLLAMA_BASE_URL;
  const ollamaModel = sourceEnv['OLLAMA_MODEL']?.trim() || DEFAULT_OLLAMA_MODEL;
  const rawApiKey = sourceEnv['OLLAMA_API_KEY']?.trim();
  const ollamaApiKey = rawApiKey && rawApiKey.length > 0 ? rawApiKey : undefined;

  const rawTimeout = Number.parseInt(
    sourceEnv['OLLAMA_TIMEOUT_MS'] ??
      sourceEnv['STREAMING_UPSTREAM_TIMEOUT_MS'] ??
      String(DEFAULT_OLLAMA_TIMEOUT_MS),
    10,
  );
  const ollamaTimeoutMs =
    Number.isSafeInteger(rawTimeout) && rawTimeout > 0 ? rawTimeout : DEFAULT_OLLAMA_TIMEOUT_MS;

  return {
    host,
    port,
    maxBodyBytes,
    providerMode,
    mockChunkDelayMs,
    ollamaBaseUrl,
    ollamaModel,
    ...(ollamaApiKey !== undefined ? { ollamaApiKey } : {}),
    ollamaTimeoutMs,
  };
}

export function createConfiguredStreamProvider(config: StreamingGatewayConfig): LLMStreamProvider {
  if (config.providerMode === 'ollama') {
    return new OllamaProvider({
      baseUrl: config.ollamaBaseUrl,
      defaultModel: config.ollamaModel,
      ...(config.ollamaApiKey !== undefined ? { apiKey: config.ollamaApiKey } : {}),
      timeoutMs: config.ollamaTimeoutMs,
    });
  }

  return new MockLLMProvider({
    chunkDelayMs: config.mockChunkDelayMs,
  });
}
