import { realpathSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { loadGatewayConfig } from './config.js';
import { createDownstreamMockServer, type DownstreamMockServerHandle } from './downstream-mock.js';
import { createMcpSecurityGateway, type SecurityGatewayHandle } from './gateway.js';

export { loadGatewayConfig, type SecurityGatewayConfig } from './config.js';
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

export async function startSecurityGatewayStack(): Promise<{
  gateway: SecurityGatewayHandle;
  downstream: DownstreamMockServerHandle | null;
  shutdown: () => Promise<void>;
}> {
  const config = loadGatewayConfig();

  let downstream: DownstreamMockServerHandle | null = null;
  let downstreamMcpUrl = config.downstreamMcpUrl;

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
      process.stderr.write(
        `${JSON.stringify({
          timestamp: new Date().toISOString(),
          level: 'error',
          component: 'mcp-security-gateway',
          message: 'Fatal startup error',
          errorName: err instanceof Error ? err.name : 'UnknownError',
        })}\n`,
      );
      process.exit(1);
    });
}
