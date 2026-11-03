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

export const DEFAULT_LOCAL_ADMIN_TOKEN = 'local-demo-admin-token-do-not-use-in-prod';
export const DEFAULT_LOCAL_VIEWER_TOKEN = 'local-demo-viewer-token-do-not-use-in-prod';

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
): SecurityGatewayConfig {
  const gatewayHost = env['GATEWAY_HOST']?.trim() || '127.0.0.1';
  const gatewayPort = parsePort(env['GATEWAY_PORT'], 4010, 'GATEWAY_PORT');
  const downstreamHost = env['DOWNSTREAM_HOST']?.trim() || '127.0.0.1';
  const downstreamPort = parsePort(env['DOWNSTREAM_PORT'], 4011, 'DOWNSTREAM_PORT');
  const downstreamMcpUrl =
    env['DOWNSTREAM_MCP_URL']?.trim() || `http://${downstreamHost}:${downstreamPort}/mcp`;
  const startDownstreamMock =
    (env['START_DOWNSTREAM_MOCK']?.trim().toLowerCase() ?? 'true') !== 'false';
  const requestTimeoutMs = parsePositiveInt(env['GATEWAY_TIMEOUT_MS'], 5000, 'GATEWAY_TIMEOUT_MS');
  const maxBodyBytes = parsePositiveInt(
    env['GATEWAY_MAX_BODY_BYTES'],
    65536,
    'GATEWAY_MAX_BODY_BYTES',
  );
  const adminToken = env['ADMIN_TOKEN'] ?? DEFAULT_LOCAL_ADMIN_TOKEN;
  const viewerToken = env['VIEWER_TOKEN'] ?? DEFAULT_LOCAL_VIEWER_TOKEN;

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
