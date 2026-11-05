import { spawn } from 'node:child_process';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { ErrorCode, McpError } from '@modelcontextprotocol/sdk/types.js';
import { afterEach, describe, expect, it } from 'vitest';
import { createStderrLogger } from '../src/config/logger.js';
import { createCustomerOpsMcpServer } from '../src/server.js';
import { CustomerService } from '../src/services/customer.service.js';

const PACKAGE_ROOT = resolve(fileURLToPath(new URL('..', import.meta.url)));
const SERVER_ENTRYPOINT = resolve(PACKAGE_ROOT, 'src', 'index.ts');
const TSX_CLI = resolve(PACKAGE_ROOT, '..', '..', 'node_modules', 'tsx', 'dist', 'cli.mjs');

describe('Task 1 MCP Server Integration (Official SDK Client & Raw Stdio Protocol)', () => {
  const activeClients: Client[] = [];

  afterEach(async () => {
    while (activeClients.length > 0) {
      const client = activeClients.pop();
      if (client) {
        await client.close();
      }
    }
  });

  async function connectSubprocessClient(): Promise<{
    client: Client;
    stderrChunks: string[];
  }> {
    const stderrChunks: string[] = [];
    const transport = new StdioClientTransport({
      command: process.execPath,
      args: [TSX_CLI, SERVER_ENTRYPOINT],
      cwd: PACKAGE_ROOT,
      stderr: 'pipe',
      env: {
        ...process.env,
        MCP_SERVER_LOG_LEVEL: 'debug',
      },
    });

    const stderrStream = transport.stderr;
    if (stderrStream) {
      stderrStream.on('data', (chunk: Buffer | string) => {
        stderrChunks.push(chunk.toString('utf8'));
      });
    }

    const client = new Client({
      name: 'task-1-integration-test-client',
      version: '1.0.0',
    });

    await client.connect(transport);
    activeClients.push(client);
    return { client, stderrChunks };
  }

  it('discovers both registered tools with strict JSON Schemas over real stdio transport', async () => {
    const { client, stderrChunks } = await connectSubprocessClient();

    const listResult = await client.listTools();
    const toolNames = listResult.tools.map((t) => t.name).sort();
    expect(toolNames).toEqual(['get_customer_record', 'trigger_refund']);

    const customerTool = listResult.tools.find((t) => t.name === 'get_customer_record');
    const refundTool = listResult.tools.find((t) => t.name === 'trigger_refund');

    expect(customerTool?.title).toBeUndefined();
    expect(refundTool?.title).toBeUndefined();
    expect(customerTool?.inputSchema.additionalProperties).toBe(false);
    expect(refundTool?.inputSchema.additionalProperties).toBe(false);
    expect(Object.keys(customerTool?.inputSchema.properties ?? {})).toEqual(['customer_id']);
    expect(Object.keys(refundTool?.inputSchema.properties ?? {}).sort()).toEqual([
      'amount',
      'customer_id',
      'reason',
    ]);
    const customerIdProp = (
      customerTool?.inputSchema.properties as Record<string, { pattern?: string }> | undefined
    )?.['customer_id'];
    expect(customerIdProp?.pattern).toBe('^CUST-[0-9]{5}$');
    expect(stderrChunks.join('')).toContain('MCP server connected over stdio transport');
  });

  it('executes get_customer_record and trigger_refund over stdio and returns deterministic JSON payloads', async () => {
    const { client } = await connectSubprocessClient();

    const customerRes = await client.callTool({
      name: 'get_customer_record',
      arguments: { customer_id: 'CUST-12345' },
    });
    expect(customerRes.isError).toBeUndefined();
    const contentList = customerRes.content as Array<{ type: string; text: string }>;
    expect(contentList).toHaveLength(1);
    const parsedCustomer = JSON.parse(contentList[0]?.text ?? '{}') as {
      found: boolean;
      customer: { customer_id: string; full_name: string };
    };
    expect(parsedCustomer.found).toBe(true);
    expect(parsedCustomer.customer.customer_id).toBe('CUST-12345');
    expect(parsedCustomer.customer.full_name).toBe('Elena Vance');

    const refundRes = await client.callTool({
      name: 'trigger_refund',
      arguments: {
        customer_id: 'CUST-12345',
        amount: 150.5,
        reason: 'Duplicate payment',
      },
    });
    expect(refundRes.isError).toBeUndefined();
    const refundContent = refundRes.content as Array<{ type: string; text: string }>;
    const parsedRefund = JSON.parse(refundContent[0]?.text ?? '{}') as {
      simulated: boolean;
      status: string;
      refund_id: string;
      amount_usd: number;
    };
    expect(parsedRefund.simulated).toBe(true);
    expect(parsedRefund.status).toBe('APPROVED');
    expect(parsedRefund.refund_id).toMatch(/^REF-[A-F0-9]{10}$/);
    expect(parsedRefund.amount_usd).toBe(150.5);
  });

  it('maps malformed inputs and unknown properties to JSON-RPC Invalid Params (-32602)', async () => {
    const { client } = await connectSubprocessClient();

    const invalidCalls: Array<{ name: string; arguments: Record<string, unknown> }> = [
      { name: 'get_customer_record', arguments: { customer_id: 'BAD-ID' } },
      {
        name: 'get_customer_record',
        arguments: { customer_id: 'CUST-12345', extra_field: 'forbidden' },
      },
      {
        name: 'trigger_refund',
        arguments: { customer_id: 'CUST-12345', amount: -25, reason: 'Duplicate payment' },
      },
      {
        name: 'trigger_refund',
        arguments: { customer_id: 'CUST-12345', amount: 0, reason: 'Duplicate payment' },
      },
      {
        name: 'trigger_refund',
        arguments: { customer_id: 'CUST-12345', amount: 50, reason: '  short  ' },
      },
      {
        name: 'trigger_refund',
        arguments: {
          customer_id: 'CUST-12345',
          amount: 50,
          reason: 'Duplicate payment',
          unexpected: 123,
        },
      },
      { name: 'non_existent_tool', arguments: {} },
    ];

    const expectedInvalidParamsCode: number = ErrorCode.InvalidParams;
    for (const call of invalidCalls) {
      await expect(client.callTool(call)).rejects.toSatisfy((err: unknown) => {
        return err instanceof McpError && err.code === expectedInvalidParamsCode;
      });
    }
  });

  it('sanitizes unexpected internal service errors without leaking stack traces or paths', async () => {
    class FailingCustomerService extends CustomerService {
      public override getCustomerRecord(): never {
        throw new Error(
          'Database password leaked at /var/secret/prod.db\n    at FailingCustomerService (secret.ts:99:1)',
        );
      }
    }

    const server = createCustomerOpsMcpServer({
      customerService: new FailingCustomerService(),
      logger: createStderrLogger('test-silent', 'silent'),
    });
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    const client = new Client({ name: 'fault-test-client', version: '1.0.0' });

    await server.connect(serverTransport);
    await client.connect(clientTransport);
    activeClients.push(client);

    await expect(
      client.callTool({
        name: 'get_customer_record',
        arguments: { customer_id: 'CUST-12345' },
      }),
    ).rejects.toSatisfy((err: unknown) => {
      if (!(err instanceof McpError)) {
        return false;
      }
      expect(err.code).toBe(ErrorCode.InternalError);
      expect(err.message).not.toContain('/var/secret/prod.db');
      expect(err.message).not.toContain('secret.ts');
      expect(err.message).not.toContain('Database password');
      return true;
    });

    await server.close();
  });

  it('guarantees stdout emits strictly valid JSON-RPC 2.0 messages with zero debug or startup text', async () => {
    const child = spawn(process.execPath, [TSX_CLI, SERVER_ENTRYPOINT], {
      cwd: PACKAGE_ROOT,
      stdio: ['pipe', 'pipe', 'pipe'],
      env: {
        ...process.env,
        MCP_SERVER_LOG_LEVEL: 'debug',
      },
    });

    const stdoutLines: string[] = [];
    let stdoutRemainder = '';
    const stderrChunks: string[] = [];

    child.stderr.on('data', (chunk: Buffer) => {
      stderrChunks.push(chunk.toString('utf8'));
    });

    const waitForResponses = (expectedCount: number): Promise<void> =>
      new Promise((resolvePromise, rejectPromise) => {
        const timeout = setTimeout(() => {
          rejectPromise(
            new Error(
              `Timed out waiting for ${expectedCount} JSON-RPC lines; got ${stdoutLines.length}`,
            ),
          );
        }, 8000);

        child.stdout.on('data', (chunk: Buffer) => {
          stdoutRemainder += chunk.toString('utf8');
          let newlineIndex = stdoutRemainder.indexOf('\n');
          while (newlineIndex !== -1) {
            const line = stdoutRemainder.slice(0, newlineIndex).replace(/\r$/, '');
            stdoutRemainder = stdoutRemainder.slice(newlineIndex + 1);
            if (line.length > 0) {
              stdoutLines.push(line);
            }
            newlineIndex = stdoutRemainder.indexOf('\n');
          }

          if (stdoutLines.length >= expectedCount) {
            clearTimeout(timeout);
            resolvePromise();
          }
        });

        child.once('error', (err) => {
          clearTimeout(timeout);
          rejectPromise(err);
        });
      });

    const responsesReady = waitForResponses(4);

    const requests = [
      {
        jsonrpc: '2.0',
        id: 1,
        method: 'initialize',
        params: {
          protocolVersion: '2024-11-05',
          capabilities: {},
          clientInfo: { name: 'raw-stdio-probe', version: '1.0.0' },
        },
      },
      {
        jsonrpc: '2.0',
        method: 'notifications/initialized',
      },
      {
        jsonrpc: '2.0',
        id: 2,
        method: 'tools/list',
        params: {},
      },
      {
        jsonrpc: '2.0',
        id: 3,
        method: 'tools/call',
        params: {
          name: 'get_customer_record',
          arguments: { customer_id: 'CUST-12345' },
        },
      },
      {
        jsonrpc: '2.0',
        id: 4,
        method: 'tools/call',
        params: {
          name: 'trigger_refund',
          arguments: { customer_id: 'CUST-12345', amount: -5, reason: 'bad' },
        },
      },
    ];

    for (const req of requests) {
      child.stdin.write(`${JSON.stringify(req)}\n`);
    }

    await responsesReady;
    child.stdin.end();
    child.kill('SIGTERM');

    expect(stdoutRemainder).toBe('');
    expect(stdoutLines).toHaveLength(4);

    for (const rawLine of stdoutLines) {
      const parsed = JSON.parse(rawLine) as Record<string, unknown>;
      expect(parsed['jsonrpc']).toBe('2.0');
    }

    const errorResponse = JSON.parse(stdoutLines[3] ?? '{}') as {
      id: number;
      error?: { code: number; message: string };
    };
    expect(errorResponse.id).toBe(4);
    expect(errorResponse.error?.code).toBe(-32602);
    expect(stderrChunks.join('')).toContain('"component":"task-1-mcp-server"');
  });
});
