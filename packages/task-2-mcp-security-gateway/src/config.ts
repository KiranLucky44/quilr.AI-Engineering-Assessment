import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseEnv } from 'node:util';

export interface SecurityGatewayConfig {
  readonly gatewayHost: string;
  readonly gatewayPort: number;
  readonly downstreamHost: string;
  readonly downstreamPort: number;
  readonly downstreamMcpUrl: string;
  readonly startDownstreamMock: boolean;
  readonly requestTimeoutMs: number;
  readonly maxBodyBytes: number;
  readonly adminToken: string;
  readonly viewerToken: string;
}

export interface LoadGatewayConfigOptions {
  readonly dotEnvPaths?: readonly string[];
}

export const DEFAULT_LOCAL_ADMIN_TOKEN = 'admin-token';
export const DEFAULT_LOCAL_VIEWER_TOKEN = 'viewer-token';

const PACKAGE_ROOT = resolve(fileURLToPath(new URL('..', import.meta.url)));
const MONOREPO_ROOT = resolve(PACKAGE_ROOT, '..', '..');

export const DEFAULT_DOTENV_PATHS: readonly string[] = [
  resolve(MONOREPO_ROOT, '.env'),
  resolve(PACKAGE_ROOT, '.env'),
];

/**
 * Reads `.env` files in order (monorepo root `.env` first, package `.env` second)
 * and returns merged key-value pairs without mutating `process.env`.
 */
export function readDotEnvFiles(
  dotEnvPaths: readonly string[] = DEFAULT_DOTENV_PATHS,
): Record<string, string> {
  const merged: Record<string, string> = {};

  for (const filePath of dotEnvPaths) {
    if (!existsSync(filePath)) {
      continue;
    }
    const content = readFileSync(filePath, 'utf8');
    const parsed = parseEnv(content);
    for (const [key, value] of Object.entries(parsed)) {
      if (value !== undefined) {
        merged[key] = value;
      }
    }
  }

  return merged;
}

/**
 * Loads `.env` values into `process.env` without overwriting variables already
 * explicitly provided in the process environment.
 */
export function loadDotEnvIntoProcessEnv(
  dotEnvPaths: readonly string[] = DEFAULT_DOTENV_PATHS,
): void {
  const fileValues = readDotEnvFiles(dotEnvPaths);
  for (const [key, value] of Object.entries(fileValues)) {
    if (process.env[key] === undefined) {
      process.env[key] = value;
    }
  }
}

function parsePositiveInt(raw: string | undefined, fallback: number, name: string): number {
  if (raw === undefined || raw.trim().length === 0) {
    return fallback;
  }
  const parsed = Number.parseInt(raw, 10);
  if (!Number.isSafeInteger(parsed) || parsed <= 0) {
    throw new Error(`${name} must be a positive integer.`);
  }
  return parsed;
}

function parsePort(raw: string | undefined, fallback: number, name: string): number {
  if (raw === undefined || raw.trim().length === 0) {
    return fallback;
  }
  const parsed = Number.parseInt(raw, 10);
  if (!Number.isSafeInteger(parsed) || parsed < 0 || parsed > 65535) {
    throw new Error(`${name} must be a valid TCP port (0-65535).`);
  }
  return parsed;
}

export function loadGatewayConfig(
  env: Readonly<Record<string, string | undefined>> = process.env,
  options?: LoadGatewayConfigOptions,
): SecurityGatewayConfig {
  const shouldReadDotEnv = env === process.env || options?.dotEnvPaths !== undefined;
  const dotEnvValues = shouldReadDotEnv ? readDotEnvFiles(options?.dotEnvPaths) : {};
  const effectiveEnv: Record<string, string | undefined> = {
    ...dotEnvValues,
  };
  for (const [key, value] of Object.entries(env)) {
    if (value !== undefined) {
      effectiveEnv[key] = value;
    }
  }

  const gatewayHost = effectiveEnv['GATEWAY_HOST']?.trim() || '127.0.0.1';
  const gatewayPort = parsePort(effectiveEnv['GATEWAY_PORT'], 4010, 'GATEWAY_PORT');
  const downstreamHost = effectiveEnv['DOWNSTREAM_HOST']?.trim() || '127.0.0.1';
  const downstreamPort = parsePort(effectiveEnv['DOWNSTREAM_PORT'], 4011, 'DOWNSTREAM_PORT');
  const downstreamMcpUrl =
    effectiveEnv['DOWNSTREAM_MCP_URL']?.trim() || `http://${downstreamHost}:${downstreamPort}/mcp`;
  const startDownstreamMock =
    (effectiveEnv['START_DOWNSTREAM_MOCK']?.trim().toLowerCase() ?? 'true') !== 'false';
  const requestTimeoutMs = parsePositiveInt(
    effectiveEnv['GATEWAY_TIMEOUT_MS'],
    5000,
    'GATEWAY_TIMEOUT_MS',
  );
  const maxBodyBytes = parsePositiveInt(
    effectiveEnv['GATEWAY_MAX_BODY_BYTES'],
    65536,
    'GATEWAY_MAX_BODY_BYTES',
  );
  const adminToken = effectiveEnv['ADMIN_TOKEN'] ?? DEFAULT_LOCAL_ADMIN_TOKEN;
  const viewerToken = effectiveEnv['VIEWER_TOKEN'] ?? DEFAULT_LOCAL_VIEWER_TOKEN;

  return {
    gatewayHost,
    gatewayPort,
    downstreamHost,
    downstreamPort,
    downstreamMcpUrl,
    startDownstreamMock,
    requestTimeoutMs,
    maxBodyBytes,
    adminToken,
    viewerToken,
  };
}
