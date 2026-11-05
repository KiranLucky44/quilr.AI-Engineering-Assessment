import { realpathSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { loadDotEnvIntoProcessEnv, loadGatewayConfig } from './config.js';
import { createDownstreamMockServer, type DownstreamMockServerHandle } from './downstream-mock.js';
import { createMcpSecurityGateway, type SecurityGatewayHandle } from './gateway.js';

export {
  DEFAULT_LOCAL_ADMIN_TOKEN,
  DEFAULT_LOCAL_VIEWER_TOKEN,
  loadDotEnvIntoProcessEnv,
  loadGatewayConfig,
  readDotEnvFiles,
  type LoadGatewayConfigOptions,
  type SecurityGatewayConfig,
} from './config.js';
export {
  createDownstreamMockServer,
  type DownstreamInvocationCounters,
  type DownstreamMockServerHandle,
} from './downstream-mock.js';
export {
  createMcpSecurityGateway,
  type GatewayLogEvent,
  type SecurityGatewayHandle,
  type SecurityGatewayOptions,
} from './gateway.js';
export { TokenVerifier } from './auth/token-verifier.js';
export { type Role } from './auth/roles.js';
export { evaluateToolAuthorization, isAdminProtectedTool } from './proxy/authorization-policy.js';
export { parseAndValidateJsonRpcBody } from './proxy/request-validator.js';

function sanitizeStartupDiagnostic(text: string): string {
  let sanitized = text;
  for (const envKey of ['ADMIN_TOKEN', 'VIEWER_TOKEN']) {
    const secret = process.env[envKey];
    if (secret && secret.trim().length > 0) {
      sanitized = sanitized.split(secret).join('[REDACTED]');
    }
  }
  return sanitized;
}

export async function startSecurityGatewayStack(): Promise<{
  gateway: SecurityGatewayHandle;
  downstream: DownstreamMockServerHandle | null;
  shutdown: () => Promise<void>;
}> {
  loadDotEnvIntoProcessEnv();
  const config = loadGatewayConfig();

  let downstream: DownstreamMockServerHandle | null = null;
  let downstreamMcpUrl = config.downstreamMcpUrl;

  try {
    if (config.startDownstreamMock) {
      downstream = createDownstreamMockServer();
      const boundDownstreamPort = await downstream.listen(
        config.downstreamPort,
        config.downstreamHost,
      );
      downstreamMcpUrl = `http://${config.downstreamHost}:${boundDownstreamPort}/mcp`;
      process.stderr.write(
        `${JSON.stringify({
          timestamp: new Date().toISOString(),
          level: 'info',
          component: 'downstream-mock-mcp',
          message: `Downstream mock MCP server listening on http://${config.downstreamHost}:${boundDownstreamPort}/mcp`,
        })}\n`,
      );
    }

    const gateway = createMcpSecurityGateway({
      downstreamMcpUrl,
      adminToken: config.adminToken,
      viewerToken: config.viewerToken,
      requestTimeoutMs: config.requestTimeoutMs,
      maxBodyBytes: config.maxBodyBytes,
    });

    const boundGatewayPort = await gateway.listen(config.gatewayPort, config.gatewayHost);
    process.stderr.write(
      `${JSON.stringify({
        timestamp: new Date().toISOString(),
        level: 'info',
        component: 'mcp-security-gateway',
        message: `MCP Security Gateway listening on http://${config.gatewayHost}:${boundGatewayPort}/mcp`,
        downstreamMcpUrl,
      })}\n`,
    );

    let closed = false;
    const shutdown = async (): Promise<void> => {
      if (closed) {
        return;
      }
      closed = true;
      await gateway.close();
      if (downstream) {
        await downstream.close();
      }
    };

    return { gateway, downstream, shutdown };
  } catch (err) {
    if (downstream) {
      await downstream.close().catch(() => undefined);
    }
    throw err;
  }
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
  startSecurityGatewayStack()
    .then(({ shutdown }) => {
      const handleSignal = (signal: string): void => {
        process.stderr.write(
          `${JSON.stringify({
            timestamp: new Date().toISOString(),
            level: 'info',
            component: 'mcp-security-gateway',
            message: `Received ${signal}, shutting down cleanly`,
          })}\n`,
        );
        void shutdown().finally(() => {
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
      const errorMessage =
        err instanceof Error ? sanitizeStartupDiagnostic(err.message) : 'Unknown startup error';
      const isDevMode = process.env['NODE_ENV'] !== 'production';
      const errorStack =
        isDevMode && err instanceof Error && err.stack
          ? sanitizeStartupDiagnostic(err.stack)
          : undefined;
      const hint =
        errorCode === 'EADDRINUSE'
          ? 'Target TCP port (4010 or 4011) is already occupied by another process. Terminate the existing instance before restarting Task 2.'
          : undefined;

      process.stderr.write(
        `${JSON.stringify({
          timestamp: new Date().toISOString(),
          level: 'error',
          component: 'mcp-security-gateway',
          message: 'Fatal startup error',
          errorName: err instanceof Error ? err.name : 'UnknownError',
          ...(errorCode !== undefined ? { errorCode } : {}),
          errorMessage,
          ...(hint !== undefined ? { hint } : {}),
          ...(errorStack !== undefined ? { stack: errorStack } : {}),
        })}\n`,
      );
      process.exit(1);
    });
}
