import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';

export interface DownstreamInvocationCounters {
  totalHttpRequests: number;
  toolsListCalls: number;
  toolsCallTotal: number;
  notificationsReceived: number;
  toolCallsByName: Record<string, number>;
}

export interface DownstreamMockOptions {
  readonly artificialDelayMs?: number;
  readonly simulateInternalError?: boolean;
}

export interface DownstreamMockServerHandle {
  readonly server: Server;
  listen(port: number, host?: string): Promise<number>;
  close(): Promise<void>;
  getCounters(): DownstreamInvocationCounters;
  resetCounters(): void;
  setOptions(options: DownstreamMockOptions): void;
}

const MOCK_TOOLS = [
  {
    name: 'get_customer_record',
    description: 'Fetch a customer profile by customer_id.',
    inputSchema: {
      type: 'object',
      properties: { customer_id: { type: 'string' } },
      required: ['customer_id'],
      additionalProperties: false,
    },
  },
  {
    name: 'lookup_order_status',
    description: 'Check deterministic order fulfillment status.',
    inputSchema: {
      type: 'object',
      properties: { order_id: { type: 'string' } },
      required: ['order_id'],
      additionalProperties: false,
    },
  },
  {
    name: 'admin_reset_key',
    description: 'Administrative operation: rotate tenant API signing key.',
    inputSchema: {
      type: 'object',
      properties: { tenant_id: { type: 'string' } },
      required: ['tenant_id'],
      additionalProperties: false,
    },
  },
  {
    name: 'admin_delete_customer',
    description: 'Administrative operation: purge customer record.',
    inputSchema: {
      type: 'object',
      properties: { customer_id: { type: 'string' } },
      required: ['customer_id'],
      additionalProperties: false,
    },
  },
  {
    name: 'admin_update_config',
    description: 'Administrative operation: update system feature flag.',
    inputSchema: {
      type: 'object',
      properties: { key: { type: 'string' }, value: { type: 'string' } },
      required: ['key', 'value'],
      additionalProperties: false,
    },
  },
] as const;

function readRequestBody(req: IncomingMessage, maxBytes = 65536): Promise<string> {
  return new Promise((resolvePromise, rejectPromise) => {
    const chunks: Buffer[] = [];
    let total = 0;

    req.on('data', (chunk: Buffer) => {
      total += chunk.length;
      if (total > maxBytes) {
        rejectPromise(new Error('PAYLOAD_TOO_LARGE'));
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });

    req.on('end', () => {
      resolvePromise(Buffer.concat(chunks).toString('utf8'));
    });

    req.on('error', (err) => {
      rejectPromise(err);
    });
  });
}

function sendJson(res: ServerResponse, statusCode: number, payload: unknown): void {
  const body = JSON.stringify(payload);
  res.writeHead(statusCode, {
    'content-type': 'application/json; charset=utf-8',
    'content-length': Buffer.byteLength(body),
  });
  res.end(body);
}

export function createDownstreamMockServer(
  initialOptions: DownstreamMockOptions = {},
): DownstreamMockServerHandle {
  let options: DownstreamMockOptions = { ...initialOptions };

  let totalHttpRequests = 0;
  let toolsListCalls = 0;
  let toolsCallTotal = 0;
  let notificationsReceived = 0;
  let toolCallsByName: Record<string, number> = {};

  const getCounters = (): DownstreamInvocationCounters => ({
    totalHttpRequests,
    toolsListCalls,
    toolsCallTotal,
    notificationsReceived,
    toolCallsByName: { ...toolCallsByName },
  });

  const resetCounters = (): void => {
    totalHttpRequests = 0;
    toolsListCalls = 0;
    toolsCallTotal = 0;
    notificationsReceived = 0;
    toolCallsByName = {};
  };

  const handleMcpPost = async (req: IncomingMessage, res: ServerResponse): Promise<void> => {
    totalHttpRequests += 1;

    if (options.artificialDelayMs && options.artificialDelayMs > 0) {
      await new Promise((r) => setTimeout(r, options.artificialDelayMs));
    }

    if (options.simulateInternalError) {
      sendJson(res, 500, {
        error: 'Simulated internal downstream crash at /srv/secret/downstream.ts:42:9',
      });
      return;
    }

    let rawBody: string;
    try {
      rawBody = await readRequestBody(req);
    } catch {
      sendJson(res, 400, {
        jsonrpc: '2.0',
        id: null,
        error: { code: -32700, message: 'Failed to read body' },
      });
      return;
    }

    let parsed: Record<string, unknown>;
    try {
      parsed = JSON.parse(rawBody) as Record<string, unknown>;
    } catch {
      sendJson(res, 400, {
        jsonrpc: '2.0',
        id: null,
        error: { code: -32700, message: 'Parse error' },
      });
      return;
    }

    const hasId = Object.prototype.hasOwnProperty.call(parsed, 'id');
    const requestId = hasId ? (parsed['id'] as string | number | null) : undefined;
    const method = typeof parsed['method'] === 'string' ? parsed['method'] : '';

    if (!hasId) {
      notificationsReceived += 1;
      res.writeHead(204);
      res.end();
      return;
    }

    if (method === 'initialize') {
      sendJson(res, 200, {
        jsonrpc: '2.0',
        id: requestId ?? null,
        result: {
          protocolVersion: '2024-11-05',
          capabilities: { tools: {} },
          serverInfo: {
            name: 'quill-downstream-mock-mcp',
            version: '1.0.0',
          },
        },
      });
      return;
    }

    if (method === 'tools/list') {
      toolsListCalls += 1;
      sendJson(res, 200, {
        jsonrpc: '2.0',
        id: requestId ?? null,
        result: {
          tools: MOCK_TOOLS,
        },
      });
      return;
    }

    if (method === 'tools/call') {
      toolsCallTotal += 1;
      const params =
        typeof parsed['params'] === 'object' && parsed['params'] !== null
          ? (parsed['params'] as Record<string, unknown>)
          : {};
      const toolName = typeof params['name'] === 'string' ? params['name'] : '';
      const args =
        typeof params['arguments'] === 'object' && params['arguments'] !== null
          ? (params['arguments'] as Record<string, unknown>)
          : {};

      toolCallsByName[toolName] = (toolCallsByName[toolName] ?? 0) + 1;

      if (toolName === 'get_customer_record') {
        const customerId =
          typeof args['customer_id'] === 'string' ? args['customer_id'] : 'CUST-12345';
        sendJson(res, 200, {
          jsonrpc: '2.0',
          id: requestId ?? null,
          result: {
            content: [
              {
                type: 'text',
                text: JSON.stringify({
                  customer_id: customerId,
                  name: 'Elena Vance',
                  tier: 'ENTERPRISE',
                  status: 'ACTIVE',
                }),
              },
            ],
          },
        });
        return;
      }

      if (toolName === 'lookup_order_status') {
        const orderId = typeof args['order_id'] === 'string' ? args['order_id'] : 'ORD-90112';
        sendJson(res, 200, {
          jsonrpc: '2.0',
          id: requestId ?? null,
          result: {
            content: [
              {
                type: 'text',
                text: JSON.stringify({
                  order_id: orderId,
                  fulfillment: 'DELIVERED',
                }),
              },
            ],
          },
        });
        return;
      }

      if (toolName === 'admin_reset_key') {
        const tenantId =
          typeof args['tenant_id'] === 'string' ? args['tenant_id'] : 'tenant-default';
        sendJson(res, 200, {
          jsonrpc: '2.0',
          id: requestId ?? null,
          result: {
            content: [
              {
                type: 'text',
                text: JSON.stringify({
                  operation: 'admin_reset_key',
                  tenant_id: tenantId,
                  key_version: 'v2-rotated',
                  simulated: true,
                }),
              },
            ],
          },
        });
        return;
      }

      if (toolName === 'admin_delete_customer' || toolName === 'admin_update_config') {
        sendJson(res, 200, {
          jsonrpc: '2.0',
          id: requestId ?? null,
          result: {
            content: [
              {
                type: 'text',
                text: JSON.stringify({
                  operation: toolName,
                  arguments: args,
                  status: 'COMPLETED_SIMULATED',
                }),
              },
            ],
          },
        });
        return;
      }

      sendJson(res, 200, {
        jsonrpc: '2.0',
        id: requestId ?? null,
        error: {
          code: -32602,
          message: `Unknown downstream tool: ${toolName}`,
        },
      });
      return;
    }

    sendJson(res, 200, {
      jsonrpc: '2.0',
      id: requestId ?? null,
      error: {
        code: -32601,
        message: `Method not found: ${method}`,
      },
    });
  };

  const server = createServer((req, res) => {
    const urlPath = (req.url ?? '/').split('?')[0];

    if (req.method === 'GET' && urlPath === '/health') {
      sendJson(res, 200, {
        status: 'ok',
        service: 'downstream-mock-mcp',
        counters: getCounters(),
      });
      return;
    }

    if (urlPath === '/mcp' && req.method === 'POST') {
      void handleMcpPost(req, res).catch(() => {
        if (!res.headersSent) {
          sendJson(res, 500, {
            jsonrpc: '2.0',
            id: null,
            error: { code: -32603, message: 'Internal downstream error' },
          });
        } else {
          res.end();
        }
      });
      return;
    }

    if (urlPath === '/mcp') {
      res.setHeader('allow', 'POST');
      sendJson(res, 405, { error: 'Method Not Allowed' });
      return;
    }

    sendJson(res, 404, { error: 'Not Found' });
  });

  return {
    server,
    listen: (port: number, host = '127.0.0.1'): Promise<number> =>
      new Promise((resolvePromise, rejectPromise) => {
        server.once('error', rejectPromise);
        server.listen(port, host, () => {
          server.removeListener('error', rejectPromise);
          const addr = server.address() as AddressInfo;
          resolvePromise(addr.port);
        });
      }),
    close: (): Promise<void> =>
      new Promise((resolvePromise, rejectPromise) => {
        if (!server.listening) {
          resolvePromise();
          return;
        }
        server.closeIdleConnections();
        server.close((err) => {
          if (err) {
            rejectPromise(err);
            return;
          }
          resolvePromise();
        });
      }),
    getCounters,
    resetCounters,
    setOptions: (nextOptions: DownstreamMockOptions): void => {
      options = { ...nextOptions };
    },
  };
}
