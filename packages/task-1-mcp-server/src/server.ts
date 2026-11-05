import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import {
  CallToolRequestSchema,
  ErrorCode,
  McpError,
  type CallToolResult,
} from '@modelcontextprotocol/sdk/types.js';
import type { ZodError } from 'zod';
import { createStderrLogger, type StderrLogger } from './config/logger.js';
import { GetCustomerRecordSchema } from './schemas/customer.schema.js';
import { TriggerRefundSchema } from './schemas/refund.schema.js';
import { CustomerService } from './services/customer.service.js';
import { RefundService } from './services/refund.service.js';

export interface CustomerOpsServerDependencies {
  readonly customerService?: CustomerService;
  readonly refundService?: RefundService;
  readonly logger?: StderrLogger;
}

function formatValidationIssues(toolName: string, error: ZodError): string {
  const details = error.issues
    .map((issue) => {
      const pathLabel = issue.path.length > 0 ? issue.path.join('.') : 'arguments';
      return `${pathLabel}: ${issue.message}`;
    })
    .join('; ');
  return `Invalid arguments for tool "${toolName}": ${details}`;
}

function createTextToolResult(payload: unknown): CallToolResult {
  return {
    content: [
      {
        type: 'text',
        text: JSON.stringify(payload),
      },
    ],
  };
}

/**
 * Constructs the Task 1 MCP server exposing `get_customer_record` and `trigger_refund`
 * with strict Zod input validation and standard JSON-RPC -32602 (Invalid Params) mapping.
 */
export function createCustomerOpsMcpServer(deps: CustomerOpsServerDependencies = {}): McpServer {
  const logger = deps.logger ?? createStderrLogger('task-1-mcp-server');
  const customerService = deps.customerService ?? new CustomerService();
  const refundService = deps.refundService ?? new RefundService();

  const mcpServer = new McpServer({
    name: 'quill-customer-ops-mcp',
    version: '1.0.0',
  });

  // Register tools via the official McpServer v1.x API so `tools/list` exposes
  // accurate JSON Schema definitions (including `additionalProperties: false`).
  mcpServer.registerTool(
    'get_customer_record',
    {
      description:
        'Retrieves a deterministic customer account profile and order history by strict customer ID (^CUST-[0-9]{5}$).',
      inputSchema: GetCustomerRecordSchema,
    },
    (input) => {
      const result = customerService.getCustomerRecord(input);
      return createTextToolResult(result);
    },
  );

  mcpServer.registerTool(
    'trigger_refund',
    {
      description:
        'Triggers a deterministic simulated customer refund after validating customer ID, positive finite amount, and reason length.',
      inputSchema: TriggerRefundSchema,
    },
    (input) => {
      const result = refundService.triggerRefund(input);
      return createTextToolResult(result);
    },
  );

  // Enforce protocol-level JSON-RPC -32602 (Invalid Params) on invalid tool names or
  // schema violations and sanitize unexpected internal exceptions (-32603) via the
  // documented `mcpServer.server` protocol hook.
  mcpServer.server.setRequestHandler(CallToolRequestSchema, (request) => {
    const toolName = request.params.name;
    const rawArgs: unknown = request.params.arguments;

    if (toolName === 'get_customer_record') {
      const parsed = GetCustomerRecordSchema.safeParse(rawArgs);
      if (!parsed.success) {
        const message = formatValidationIssues(toolName, parsed.error);
        logger.warn('Rejected invalid get_customer_record arguments', {
          tool: toolName,
          issues: parsed.error.issues.map((issue) => ({
            path: issue.path.join('.') || 'arguments',
            code: issue.code,
            message: issue.message,
          })),
        });
        throw new McpError(ErrorCode.InvalidParams, message);
      }

      try {
        const record = customerService.getCustomerRecord(parsed.data);
        logger.debug('Executed get_customer_record', {
          customer_id: parsed.data.customer_id,
          found: record.found,
        });
        return createTextToolResult(record);
      } catch (err) {
        logger.error('Unexpected internal failure in get_customer_record', {
          errorName: err instanceof Error ? err.name : 'UnknownError',
        });
        throw new McpError(
          ErrorCode.InternalError,
          'Internal error while executing get_customer_record.',
        );
      }
    }

    if (toolName === 'trigger_refund') {
      const parsed = TriggerRefundSchema.safeParse(rawArgs);
      if (!parsed.success) {
        const message = formatValidationIssues(toolName, parsed.error);
        logger.warn('Rejected invalid trigger_refund arguments', {
          tool: toolName,
          issues: parsed.error.issues.map((issue) => ({
            path: issue.path.join('.') || 'arguments',
            code: issue.code,
            message: issue.message,
          })),
        });
        throw new McpError(ErrorCode.InvalidParams, message);
      }

      try {
        const refundResult = refundService.triggerRefund(parsed.data);
        logger.info('Executed simulated trigger_refund', {
          customer_id: parsed.data.customer_id,
          refund_id: refundResult.refund_id,
          status: refundResult.status,
        });
        return createTextToolResult(refundResult);
      } catch (err) {
        logger.error('Unexpected internal failure in trigger_refund', {
          errorName: err instanceof Error ? err.name : 'UnknownError',
        });
        throw new McpError(
          ErrorCode.InternalError,
          'Internal error while executing trigger_refund.',
        );
      }
    }

    logger.warn('Rejected call to unknown tool', { tool: toolName });
    throw new McpError(ErrorCode.InvalidParams, `Unknown tool "${toolName}".`);
  });

  mcpServer.server.onerror = (error) => {
    logger.error('MCP protocol error', {
      errorName: error.name,
      code: error instanceof McpError ? error.code : undefined,
    });
  };

  return mcpServer;
}
