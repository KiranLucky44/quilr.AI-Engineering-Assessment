import { realpathSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import type { Database as BetterSqliteDatabase } from 'better-sqlite3';
import { loadRouterConfig, type ModelRouterConfig } from './config.js';
import { openRouterDatabase } from './database/database.js';
import { SlidingWindowLimiter } from './limiter/sliding-window-limiter.js';
import { TiktokenTokenCounter } from './limiter/token-counter.js';
import { MockPrimaryProvider } from './providers/mock-primary.provider.js';
import { MockSecondaryProvider } from './providers/mock-secondary.provider.js';
import { ModelRouter } from './router/model-router.js';
import { createModelRouterServer, type ModelRouterServerHandle } from './server.js';

export { loadRouterConfig, type DemoScenario, type ModelRouterConfig } from './config.js';
export { DEFAULT_ROUTER_DB_PATH, openRouterDatabase } from './database/database.js';
export {
  GatewayError,
  ProviderHttpError,
  ProviderTimeoutError,
  type GatewayErrorCode,
  type StandardizedErrorPayload,
} from './errors/gateway-errors.js';
export {
  hashTenantApiKey,
  SlidingWindowLimiter,
  type ReservationOutcome,
} from './limiter/sliding-window-limiter.js';
export { TiktokenTokenCounter, type TokenCounter } from './limiter/token-counter.js';
export { MockPrimaryProvider } from './providers/mock-primary.provider.js';
export { MockSecondaryProvider } from './providers/mock-secondary.provider.js';
export { type ModelProvider } from './providers/model-provider.interface.js';
export { evaluateFallbackPolicy } from './router/fallback-policy.js';
export { ModelRouter } from './router/model-router.js';
export { createModelRouterServer, type ModelRouterServerHandle } from './server.js';

export async function startModelRouterApp(explicitConfig?: ModelRouterConfig): Promise<{
  server: ModelRouterServerHandle;
  db: BetterSqliteDatabase;
  shutdown: () => Promise<void>;
}> {
  const config = explicitConfig ?? loadRouterConfig();
  const db = openRouterDatabase({ dbPath: config.dbPath });

  const limiter = new SlidingWindowLimiter({
    db,
    windowMs: config.windowMs,
    quotaLimit: config.tokenQuota,
  });

  const tokenCounter = new TiktokenTokenCounter();
  const primaryProvider = new MockPrimaryProvider();
  const secondaryProvider = new MockSecondaryProvider();

  const router = new ModelRouter({
    primaryProvider,
    secondaryProvider,
    limiter,
    tokenCounter,
    primaryTimeoutMs: config.primaryTimeoutMs,
    secondaryTimeoutMs: config.secondaryTimeoutMs,
    defaultMaxTokens: config.defaultMaxTokens,
    windowMs: config.windowMs,
  });

  const server = createModelRouterServer({
    router,
    maxBodyBytes: config.maxBodyBytes,
    defaultScenario: config.defaultScenario,
  });

  const boundPort = await server.listen(config.port, config.host);

  process.stderr.write(
    `${JSON.stringify({
      timestamp: new Date().toISOString(),
      level: 'info',
      component: 'task-4-model-router',
      message: `Model Router Gateway listening on http://${config.host}:${boundPort}/v1/chat/completions`,
      tokenQuotaPerWindow: config.tokenQuota,
      windowMs: config.windowMs,
      primaryTimeoutMs: config.primaryTimeoutMs,
    })}\n`,
  );

  let closed = false;
  const shutdown = async (): Promise<void> => {
    if (closed) {
      return;
    }
    closed = true;
    await server.close();
    db.close();
  };

  return { server, db, shutdown };
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
  startModelRouterApp()
    .then(({ shutdown }) => {
      const handleSignal = (signal: string): void => {
        process.stderr.write(
          `${JSON.stringify({
            timestamp: new Date().toISOString(),
            level: 'info',
            component: 'task-4-model-router',
            message: `Received ${signal}, closing HTTP server and SQLite WAL database`,
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
          component: 'task-4-model-router',
          message: 'Fatal startup error in Task 4 Model Router',
          errorName: err instanceof Error ? err.name : 'UnknownError',
        })}\n`,
      );
      process.exit(1);
    });
}
