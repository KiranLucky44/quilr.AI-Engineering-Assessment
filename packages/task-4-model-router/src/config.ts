import { resolve } from 'node:path';
import { DEFAULT_ROUTER_DB_PATH } from './database/database.js';

export type DemoScenario =
  | 'success'
  | 'primary_429'
  | 'primary_timeout'
  | 'primary_500'
  | 'secondary_unavailable'
  | 'both_unavailable';

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

export function loadRouterConfig(
  env: Readonly<Record<string, string | undefined>> = process.env,
): ModelRouterConfig {
  const host = env['ROUTER_HOST']?.trim() || '127.0.0.1';
  const port = parsePort(env['ROUTER_PORT'], 4030);
  const dbPath = env['ROUTER_DB_PATH']?.trim()
    ? resolve(env['ROUTER_DB_PATH'].trim())
    : DEFAULT_ROUTER_DB_PATH;
  const windowMs = parsePositiveInt(env['ROUTER_WINDOW_MS'], 60_000, 'ROUTER_WINDOW_MS');
  const tokenQuota = parsePositiveInt(env['ROUTER_TOKEN_QUOTA'], 50_000, 'ROUTER_TOKEN_QUOTA');
  const defaultMaxTokens = parsePositiveInt(
    env['ROUTER_DEFAULT_MAX_TOKENS'],
    256,
    'ROUTER_DEFAULT_MAX_TOKENS',
  );
  const primaryTimeoutMs = parsePositiveInt(
    env['ROUTER_PRIMARY_TIMEOUT_MS'],
    3_000,
    'ROUTER_PRIMARY_TIMEOUT_MS',
  );
  const secondaryTimeoutMs = parsePositiveInt(
    env['ROUTER_SECONDARY_TIMEOUT_MS'],
    3_000,
    'ROUTER_SECONDARY_TIMEOUT_MS',
  );
  const maxBodyBytes = parsePositiveInt(
    env['ROUTER_MAX_BODY_BYTES'],
    131_072,
    'ROUTER_MAX_BODY_BYTES',
  );
  const defaultScenario = parseScenario(env['ROUTER_DEMO_SCENARIO']?.trim());

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
  };
}
