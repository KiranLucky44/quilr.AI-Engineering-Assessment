import { existsSync, readFileSync } from 'node:fs';
import { isAbsolute, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseEnv } from 'node:util';
import { DEFAULT_ROUTER_DB_PATH } from './database/database.js';
import { MockPrimaryProvider } from './providers/mock-primary.provider.js';
import { MockSecondaryProvider } from './providers/mock-secondary.provider.js';
import type { ModelProvider } from './providers/model-provider.interface.js';
import {
  DEFAULT_OLLAMA_BASE_URL,
  DEFAULT_OLLAMA_MODEL,
  OpenAICompatibleModelProvider,
} from './providers/openai-compatible.provider.js';

export type DemoScenario =
  | 'success'
  | 'primary_429'
  | 'primary_timeout'
  | 'primary_500'
  | 'secondary_unavailable'
  | 'both_unavailable';

export type RouterProviderMode = 'mock' | 'ollama' | 'openai-compatible';

export interface ProviderEndpointConfig {
  readonly mode: RouterProviderMode;
  readonly baseUrl: string;
  readonly model?: string;
  readonly apiKey?: string;
}

export interface ModelRouterConfig {
  readonly host: string;
  readonly port: number;
  readonly dbPath: string;
  readonly windowMs: number;
  readonly tokenQuota: number;
  readonly defaultMaxTokens: number;
  readonly primaryTimeoutMs: number;
  readonly secondaryTimeoutMs: number;
  readonly maxBodyBytes: number;
  readonly defaultScenario: DemoScenario;
  readonly primaryProvider?: ProviderEndpointConfig;
  readonly secondaryProvider?: ProviderEndpointConfig;
}

const PACKAGE_ROOT = fileURLToPath(new URL('..', import.meta.url));
const MONOREPO_ROOT = resolve(PACKAGE_ROOT, '..', '..');
const MONOREPO_ROOT_ENV_PATH = resolve(MONOREPO_ROOT, '.env');
const PACKAGE_ENV_PATH = resolve(PACKAGE_ROOT, '.env');

function resolveDbPath(rawPath: string | undefined): string {
  if (!rawPath || rawPath.trim().length === 0) {
    return DEFAULT_ROUTER_DB_PATH;
  }
  const trimmed = rawPath.trim();
  if (isAbsolute(trimmed)) {
    return trimmed;
  }
  if (
    trimmed.startsWith('packages/task-4-model-router/') ||
    trimmed.startsWith('packages\\task-4-model-router\\')
  ) {
    return resolve(MONOREPO_ROOT, trimmed);
  }
  return resolve(trimmed);
}

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

function parsePositiveInt(raw: string | undefined, fallback: number, name: string): number {
  if (!raw || raw.trim().length === 0) {
    return fallback;
  }
  const parsed = Number.parseInt(raw, 10);
  if (!Number.isSafeInteger(parsed) || parsed <= 0) {
    throw new Error(`${name} must be a positive integer.`);
  }
  return parsed;
}

function parsePort(raw: string | undefined, fallback: number): number {
  if (!raw || raw.trim().length === 0) {
    return fallback;
  }
  const parsed = Number.parseInt(raw, 10);
  if (!Number.isSafeInteger(parsed) || parsed < 0 || parsed > 65535) {
    throw new Error('ROUTER_PORT must be a valid TCP port (0-65535).');
  }
  return parsed;
}

function parseScenario(raw: string | undefined): DemoScenario {
  if (
    raw === 'success' ||
    raw === 'primary_429' ||
    raw === 'primary_timeout' ||
    raw === 'primary_500' ||
    raw === 'secondary_unavailable' ||
    raw === 'both_unavailable'
  ) {
    return raw;
  }
  return 'success';
}

function parseProviderMode(
  raw: string | undefined,
  fallback: RouterProviderMode,
  envName: string,
): RouterProviderMode {
  if (!raw || raw.trim().length === 0) {
    return fallback;
  }
  const normalized = raw.trim().toLowerCase();
  if (normalized === 'mock' || normalized === 'ollama' || normalized === 'openai-compatible') {
    return normalized;
  }
  throw new Error(`${envName} must be one of "mock", "ollama", or "openai-compatible".`);
}

export interface LoadRouterConfigOptions {
  readonly envFilePaths?: readonly string[];
  readonly skipDotEnv?: boolean;
}

export function loadRouterConfig(
  env?: Readonly<Record<string, string | undefined>>,
  options: LoadRouterConfigOptions = {},
): ModelRouterConfig {
  const fileEnv =
    options.skipDotEnv || env !== undefined ? {} : readDotEnvFiles(options.envFilePaths);
  const sourceEnv: Readonly<Record<string, string | undefined>> = env ?? {
    ...fileEnv,
    ...process.env,
  };

  const host = sourceEnv['ROUTER_HOST']?.trim() || '127.0.0.1';
  const port = parsePort(sourceEnv['ROUTER_PORT'], 4030);
  const dbPath = resolveDbPath(sourceEnv['ROUTER_DB_PATH']);
  const windowMs = parsePositiveInt(sourceEnv['ROUTER_WINDOW_MS'], 60_000, 'ROUTER_WINDOW_MS');
  const tokenQuota = parsePositiveInt(
    sourceEnv['ROUTER_TOKEN_QUOTA'],
    50_000,
    'ROUTER_TOKEN_QUOTA',
  );
  const defaultMaxTokens = parsePositiveInt(
    sourceEnv['ROUTER_DEFAULT_MAX_TOKENS'],
    256,
    'ROUTER_DEFAULT_MAX_TOKENS',
  );
  const primaryTimeoutMs = parsePositiveInt(
    sourceEnv['ROUTER_PRIMARY_TIMEOUT_MS'],
    3_000,
    'ROUTER_PRIMARY_TIMEOUT_MS',
  );
  const secondaryTimeoutMs = parsePositiveInt(
    sourceEnv['ROUTER_SECONDARY_TIMEOUT_MS'],
    3_000,
    'ROUTER_SECONDARY_TIMEOUT_MS',
  );
  const maxBodyBytes = parsePositiveInt(
    sourceEnv['ROUTER_MAX_BODY_BYTES'],
    131_072,
    'ROUTER_MAX_BODY_BYTES',
  );
  const defaultScenario = parseScenario(sourceEnv['ROUTER_DEMO_SCENARIO']?.trim());

  const globalMode = parseProviderMode(sourceEnv['LLM_PROVIDER'], 'mock', 'LLM_PROVIDER');
  const sharedOllamaBaseUrl = sourceEnv['OLLAMA_BASE_URL']?.trim() || DEFAULT_OLLAMA_BASE_URL;
  const sharedOllamaModel = sourceEnv['OLLAMA_MODEL']?.trim() || DEFAULT_OLLAMA_MODEL;

  const primaryMode = parseProviderMode(
    sourceEnv['ROUTER_PRIMARY_PROVIDER'],
    globalMode,
    'ROUTER_PRIMARY_PROVIDER',
  );
  const secondaryMode = parseProviderMode(
    sourceEnv['ROUTER_SECONDARY_PROVIDER'],
    globalMode,
    'ROUTER_SECONDARY_PROVIDER',
  );

  const primaryModelRaw =
    sourceEnv['ROUTER_PRIMARY_MODEL']?.trim() ||
    (primaryMode === 'ollama' ? sharedOllamaModel : undefined);
  const primaryApiKeyRaw = sourceEnv['ROUTER_PRIMARY_API_KEY']?.trim();

  const secondaryModelRaw =
    sourceEnv['ROUTER_SECONDARY_MODEL']?.trim() ||
    (secondaryMode === 'ollama' ? sharedOllamaModel : undefined);
  const secondaryApiKeyRaw = sourceEnv['ROUTER_SECONDARY_API_KEY']?.trim();

  const primaryProvider: ProviderEndpointConfig = {
    mode: primaryMode,
    baseUrl: sourceEnv['ROUTER_PRIMARY_BASE_URL']?.trim() || sharedOllamaBaseUrl,
    ...(primaryModelRaw ? { model: primaryModelRaw } : {}),
    ...(primaryApiKeyRaw ? { apiKey: primaryApiKeyRaw } : {}),
  };

  const secondaryProvider: ProviderEndpointConfig = {
    mode: secondaryMode,
    baseUrl: sourceEnv['ROUTER_SECONDARY_BASE_URL']?.trim() || sharedOllamaBaseUrl,
    ...(secondaryModelRaw ? { model: secondaryModelRaw } : {}),
    ...(secondaryApiKeyRaw ? { apiKey: secondaryApiKeyRaw } : {}),
  };

  return {
    host,
    port,
    dbPath,
    windowMs,
    tokenQuota,
    defaultMaxTokens,
    primaryTimeoutMs,
    secondaryTimeoutMs,
    maxBodyBytes,
    defaultScenario,
    primaryProvider,
    secondaryProvider,
  };
}

export function createRouterProviders(config: ModelRouterConfig): {
  primaryProvider: ModelProvider;
  secondaryProvider: ModelProvider;
} {
  const primaryCfg = config.primaryProvider ?? {
    mode: 'mock',
    baseUrl: DEFAULT_OLLAMA_BASE_URL,
  };
  const secondaryCfg = config.secondaryProvider ?? {
    mode: 'mock',
    baseUrl: DEFAULT_OLLAMA_BASE_URL,
  };

  const primaryProvider: ModelProvider =
    primaryCfg.mode === 'mock'
      ? new MockPrimaryProvider()
      : new OpenAICompatibleModelProvider({
          providerName: primaryCfg.mode === 'ollama' ? 'ollama-primary' : 'openai-primary',
          baseUrl: primaryCfg.baseUrl,
          ...(primaryCfg.model !== undefined ? { configuredModel: primaryCfg.model } : {}),
          ...(primaryCfg.apiKey !== undefined ? { apiKey: primaryCfg.apiKey } : {}),
          timeoutMs: config.primaryTimeoutMs,
        });

  const secondaryProvider: ModelProvider =
    secondaryCfg.mode === 'mock'
      ? new MockSecondaryProvider()
      : new OpenAICompatibleModelProvider({
          providerName: secondaryCfg.mode === 'ollama' ? 'ollama-secondary' : 'openai-secondary',
          baseUrl: secondaryCfg.baseUrl,
          ...(secondaryCfg.model !== undefined ? { configuredModel: secondaryCfg.model } : {}),
          ...(secondaryCfg.apiKey !== undefined ? { apiKey: secondaryCfg.apiKey } : {}),
          timeoutMs: config.secondaryTimeoutMs,
        });

  return { primaryProvider, secondaryProvider };
}
