import { realpathSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { createStderrLogger } from './config/logger.js';
import { createCustomerOpsMcpServer } from './server.js';

export { createCustomerOpsMcpServer } from './server.js';
export { GetCustomerRecordSchema, type GetCustomerRecordInput } from './schemas/customer.schema.js';
export { TriggerRefundSchema, type TriggerRefundInput } from './schemas/refund.schema.js';
export { CustomerService } from './services/customer.service.js';
export { RefundService } from './services/refund.service.js';

export async function startStdioMcpServer(): Promise<void> {
  const logger = createStderrLogger('task-1-mcp-server');
  const mcpServer = createCustomerOpsMcpServer({ logger });
  const transport = new StdioServerTransport();

  let shuttingDown = false;
  const shutdown = async (signal: string): Promise<void> => {
    if (shuttingDown) {
      return;
    }
    shuttingDown = true;
    logger.info('Shutting down MCP server', { signal });
    try {
      await mcpServer.close();
    } catch (err) {
      logger.error('Error while closing MCP server', {
        errorName: err instanceof Error ? err.name : 'UnknownError',
      });
    }
  };

  process.once('SIGINT', () => {
    void shutdown('SIGINT');
  });
  process.once('SIGTERM', () => {
    void shutdown('SIGTERM');
  });

  await mcpServer.connect(transport);
  logger.info('MCP server connected over stdio transport', {
    tools: ['get_customer_record', 'trigger_refund'],
  });
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
  const logger = createStderrLogger('task-1-mcp-server');
  startStdioMcpServer().catch((err: unknown) => {
    logger.error('Fatal startup failure in MCP server', {
      errorName: err instanceof Error ? err.name : 'UnknownError',
    });
    process.exit(1);
  });
}
