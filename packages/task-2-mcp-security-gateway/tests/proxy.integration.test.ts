import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  createDownstreamMockServer,
  type DownstreamMockServerHandle,
} from '../src/downstream-mock.js';
import {
  createMcpSecurityGateway,
  type GatewayLogEvent,
  type SecurityGatewayHandle,
} from '../src/gateway.js';

describe('Task 2 MCP Security Gateway End-to-End Proxy Integration', () => {
  const ADMIN_TOKEN = 'secret-admin-bearer-token-value-xyz';
  const VIEWER_TOKEN = 'secret-viewer-bearer-token-value-abc';

  let downstream: DownstreamMockServerHandle;
  let gateway: SecurityGatewayHandle;
  let gatewayUrl: string;
  let downstreamPort: number;
  let capturedLogs: GatewayLogEvent[];

  beforeEach(async () => {
    capturedLogs = [];
    downstream = createDownstreamMockServer();
    downstreamPort = await downstream.listen(0, '127.0.0.1');

    gateway = createMcpSecurityGateway({
      downstreamMcpUrl: `http://127.0.0.1:${downstreamPort}/mcp`,
      adminToken: ADMIN_TOKEN,
      viewerToken: VIEWER_TOKEN,
      requestTimeoutMs: 250,
      maxBodyBytes: 2048,
      logSink: (entry) => {
        capturedLogs.push(entry);
      },
    });
    const gatewayPort = await gateway.listen(0, '127.0.0.1');
    gatewayUrl = `http://127.0.0.1:${gatewayPort}/mcp`;
  });

  afterEach(async () => {
    await gateway.close();
    await downstream.close();
  });

  it('returns HTTP 401 for missing or invalid bearer tokens without contacting downstream', async () => {
    const missingRes = await fetch(gatewayUrl, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/list' }),
    });
    expect(missingRes.status).toBe(401);

    const invalidRes = await fetch(gatewayUrl, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        authorization: 'Bearer completely-wrong-token',
      },
      body: JSON.stringify({ jsonrpc: '2.0', id: 2, method: 'tools/list' }),
    });
    expect(invalidRes.status).toBe(401);
    expect(downstream.getCounters().totalHttpRequests).toBe(0);
  });

  it('forwards tools/list transparently for both viewer and admin without filtering tool names', async () => {
    const viewerRes = await fetch(gatewayUrl, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        authorization: `Bearer ${VIEWER_TOKEN}`,
      },
      body: JSON.stringify({ jsonrpc: '2.0', id: 'list-viewer-1', method: 'tools/list' }),
    });

    expect(viewerRes.status).toBe(200);
    const body = (await viewerRes.json()) as {
      jsonrpc: string;
      id: string;
      result: { tools: Array<{ name: string }> };
    };
    expect(body.jsonrpc).toBe('2.0');
    expect(body.id).toBe('list-viewer-1');
    const names = body.result.tools.map((t) => t.name);
    expect(names).toContain('get_customer_record');
    expect(names).toContain('admin_reset_key');
    expect(downstream.getCounters().toolsListCalls).toBe(1);
  });

  it('allows viewer to call non-admin tools and preserves request ID', async () => {
    const res = await fetch(gatewayUrl, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        authorization: `Bearer ${VIEWER_TOKEN}`,
      },
      body: JSON.stringify({
        jsonrpc: '2.0',
        id: 707,
        method: 'tools/call',
        params: {
          name: 'get_customer_record',
          arguments: { customer_id: 'CUST-12345' },
        },
      }),
    });

    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      jsonrpc: string;
      id: number;
      result: { content: Array<{ text: string }> };
    };
    expect(body.id).toBe(707);
    expect(body.result.content[0]?.text).toContain('CUST-12345');
    expect(downstream.getCounters().toolCallsByName['get_customer_record']).toBe(1);
  });

  it('CRITICAL SECURITY CHECK: blocks viewer calling admin_reset_key with -32001 and zero downstream invocations', async () => {
    const res = await fetch(gatewayUrl, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        authorization: `Bearer ${VIEWER_TOKEN}`,
      },
      body: JSON.stringify({
        jsonrpc: '2.0',
        id: 'sec-audit-99',
        method: 'tools/call',
        params: {
          name: 'admin_reset_key',
          arguments: { tenant_id: 'tenant-prod' },
        },
      }),
    });

    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      jsonrpc: string;
      id: string;
      error: { code: number; message: string };
    };
    expect(body).toEqual({
      jsonrpc: '2.0',
      id: 'sec-audit-99',
      error: {
        code: -32001,
        message: 'Unauthorized Tool Call',
      },
    });

    const counters = downstream.getCounters();
    expect(counters.totalHttpRequests).toBe(0);
    expect(counters.toolCallsByName['admin_reset_key'] ?? 0).toBe(0);
  });

  it('allows admin to call admin_reset_key and increments downstream counter', async () => {
    const res = await fetch(gatewayUrl, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        authorization: `Bearer ${ADMIN_TOKEN}`,
      },
      body: JSON.stringify({
        jsonrpc: '2.0',
        id: 42,
        method: 'tools/call',
        params: {
          name: 'admin_reset_key',
          arguments: { tenant_id: 'tenant-prod' },
        },
      }),
    });

    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      jsonrpc: string;
      id: number;
      result: { content: Array<{ text: string }> };
    };
    expect(body.id).toBe(42);
    expect(body.result.content[0]?.text).toContain('admin_reset_key');
    expect(downstream.getCounters().toolCallsByName['admin_reset_key']).toBe(1);
  });

  it('handles notifications properly without inventing a response ID and blocks unauthorized admin notifications', async () => {
    const blockedNotif = await fetch(gatewayUrl, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        authorization: `Bearer ${VIEWER_TOKEN}`,
      },
      body: JSON.stringify({
        jsonrpc: '2.0',
        method: 'tools/call',
        params: { name: 'admin_delete_customer', arguments: { customer_id: 'CUST-12345' } },
      }),
    });
    expect(blockedNotif.status).toBe(204);
    expect(await blockedNotif.text()).toBe('');
    expect(downstream.getCounters().totalHttpRequests).toBe(0);

    const allowedNotif = await fetch(gatewayUrl, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        authorization: `Bearer ${VIEWER_TOKEN}`,
      },
      body: JSON.stringify({
        jsonrpc: '2.0',
        method: 'notifications/initialized',
      }),
    });
    expect(allowedNotif.status).toBe(204);
    expect(await allowedNotif.text()).toBe('');
    expect(downstream.getCounters().notificationsReceived).toBe(1);
  });

  it('rejects invalid JSON, missing params.name, wrong HTTP methods, wrong Content-Type, and oversized bodies', async () => {
    const wrongMethod = await fetch(gatewayUrl, { method: 'GET' });
    expect(wrongMethod.status).toBe(405);

    const wrongContentType = await fetch(gatewayUrl, {
      method: 'POST',
      headers: {
        'content-type': 'text/plain',
        authorization: `Bearer ${ADMIN_TOKEN}`,
      },
      body: '{}',
    });
    expect(wrongContentType.status).toBe(415);

    const badJson = await fetch(gatewayUrl, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        authorization: `Bearer ${ADMIN_TOKEN}`,
      },
      body: '{invalid-json',
    });
    expect(badJson.status).toBe(400);
    const badJsonBody = (await badJson.json()) as { error: { code: number } };
    expect(badJsonBody.error.code).toBe(-32700);

    const missingToolName = await fetch(gatewayUrl, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        authorization: `Bearer ${ADMIN_TOKEN}`,
      },
      body: JSON.stringify({
        jsonrpc: '2.0',
        id: 'missing-name-id',
        method: 'tools/call',
        params: { arguments: {} },
      }),
    });
    const missingBody = (await missingToolName.json()) as {
      id: string;
      error: { code: number };
    };
    expect(missingBody.id).toBe('missing-name-id');
    expect(missingBody.error.code).toBe(-32602);

    const hugeBody = await fetch(gatewayUrl, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        authorization: `Bearer ${ADMIN_TOKEN}`,
      },
      body: JSON.stringify({
        jsonrpc: '2.0',
        id: 1,
        method: 'tools/call',
        params: { name: 'get_customer_record', padding: 'x'.repeat(5000) },
      }),
    });
    expect(hugeBody.status).toBe(413);
  });

  it('handles downstream unavailability, timeouts, and internal 500s without leaking stack traces', async () => {
    downstream.setOptions({ simulateInternalError: true });
    const err500Res = await fetch(gatewayUrl, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        authorization: `Bearer ${ADMIN_TOKEN}`,
      },
      body: JSON.stringify({ jsonrpc: '2.0', id: 'ds-500', method: 'tools/list' }),
    });
    expect(err500Res.status).toBe(502);
    const err500Text = await err500Res.text();
    expect(err500Text).not.toContain('/srv/secret/downstream.ts');

    downstream.setOptions({ artificialDelayMs: 600 });
    const timeoutRes = await fetch(gatewayUrl, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        authorization: `Bearer ${ADMIN_TOKEN}`,
      },
      body: JSON.stringify({ jsonrpc: '2.0', id: 'ds-timeout', method: 'tools/list' }),
    });
    expect(timeoutRes.status).toBe(504);
    const timeoutBody = (await timeoutRes.json()) as { id: string; error: { code: number } };
    expect(timeoutBody.id).toBe('ds-timeout');

    await downstream.close();
    const downRes = await fetch(gatewayUrl, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        authorization: `Bearer ${ADMIN_TOKEN}`,
      },
      body: JSON.stringify({ jsonrpc: '2.0', id: 'ds-closed', method: 'tools/list' }),
    });
    expect(downRes.status).toBe(502);
    const downBody = (await downRes.json()) as { id: string; error: { code: number } };
    expect(downBody.id).toBe('ds-closed');
  });

  it('never leaks plaintext bearer credentials into gateway logs or responses', async () => {
    await fetch(gatewayUrl, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        authorization: `Bearer ${ADMIN_TOKEN}`,
      },
      body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/list' }),
    });

    await fetch(gatewayUrl, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        authorization: `Bearer ${VIEWER_TOKEN}`,
      },
      body: JSON.stringify({
        jsonrpc: '2.0',
        id: 2,
        method: 'tools/call',
        params: { name: 'admin_reset_key' },
      }),
    });

    const serializedLogs = JSON.stringify(capturedLogs);
    expect(serializedLogs).not.toContain(ADMIN_TOKEN);
    expect(serializedLogs).not.toContain(VIEWER_TOKEN);
  });
});
