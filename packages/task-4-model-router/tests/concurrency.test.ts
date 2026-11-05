import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Worker } from 'node:worker_threads';
import { afterEach, describe, expect, it } from 'vitest';
import { openRouterDatabase } from '../src/database/database.js';
import type { StandardizedErrorPayload } from '../src/errors/gateway-errors.js';
import { hashTenantApiKey, SlidingWindowLimiter } from '../src/limiter/sliding-window-limiter.js';
import { TiktokenTokenCounter } from '../src/limiter/token-counter.js';
import { MockPrimaryProvider } from '../src/providers/mock-primary.provider.js';
import { MockSecondaryProvider } from '../src/providers/mock-secondary.provider.js';
import { ModelRouter } from '../src/router/model-router.js';
import { createModelRouterServer, type ModelRouterServerHandle } from '../src/server.js';

interface LedgerAuditRow {
  readonly id: number;
  readonly request_id: string;
  readonly reserved_tokens: number;
  readonly actual_tokens: number | null;
  readonly status: 'RESERVED' | 'SETTLED' | 'RELEASED';
}

describe('Atomic Concurrency Protection (BEGIN IMMEDIATE) (Task 4)', () => {
  const tempDirs: string[] = [];
  const activeServers: ModelRouterServerHandle[] = [];

  afterEach(async () => {
    while (activeServers.length > 0) {
      const srv = activeServers.pop();
      if (srv) {
        await srv.close();
      }
    }
    while (tempDirs.length > 0) {
      const dir = tempDirs.pop();
      if (dir) {
        rmSync(dir, { recursive: true, force: true });
      }
    }
  });

  it('prevents concurrent in-process bursts from exceeding tenant quota', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'quill-task4-conc-'));
    tempDirs.push(dir);
    const dbPath = join(dir, 'concurrent.sqlite');

    const dbA = openRouterDatabase({ dbPath });
    const dbB = openRouterDatabase({ dbPath });

    const limiterA = new SlidingWindowLimiter({ db: dbA, quotaLimit: 50_000 });
    const limiterB = new SlidingWindowLimiter({ db: dbB, quotaLimit: 50_000 });

    const tenantKey = 'sk-concurrent-tenant-key';

    // Launch 20 simultaneous 10,000-token reservation attempts across two independent DB connections.
    const attempts = Array.from({ length: 20 }, (_, idx) =>
      Promise.resolve().then(() => {
        const chosen = idx % 2 === 0 ? limiterA : limiterB;
        return chosen.tryReserveTokens(tenantKey, `req_burst_${idx}`, 10_000);
      }),
    );

    const outcomes = await Promise.all(attempts);
    const accepted = outcomes.filter((o) => o.allowed);
    const rejected = outcomes.filter((o) => !o.allowed);

    expect(accepted).toHaveLength(5);
    expect(rejected).toHaveLength(15);
    expect(limiterA.getActiveTenantUsage(tenantKey)).toBe(50_000);

    dbA.close();
    dbB.close();
  });

  it('prevents true OS multi-thread parallel SQLite connections from over-allocating a 50,000 quota', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'quill-task4-threads-'));
    tempDirs.push(dir);
    const dbPath = join(dir, 'threads.sqlite');

    // Initialize schema once before spawning competing worker threads
    const initDb = openRouterDatabase({ dbPath });
    initDb.close();

    const workerScript = `
      import { parentPort, workerData } from 'node:worker_threads';
      import Database from 'better-sqlite3';
      import { createHash } from 'node:crypto';

      const db = new Database(workerData.dbPath);
      db.pragma('journal_mode = WAL');
      db.pragma('busy_timeout = 5000');
      db.pragma('foreign_keys = ON');

      const tenantHash = createHash('sha256').update(workerData.apiKey, 'utf8').digest('hex');

      const reserveTx = db.transaction((reqId, tokens, quota) => {
        const now = Date.now();
        db.prepare(\`
          INSERT INTO tenants (tenant_hash, created_at, last_seen_at)
          VALUES (?, ?, ?)
          ON CONFLICT(tenant_hash) DO UPDATE SET last_seen_at = excluded.last_seen_at
        \`).run(tenantHash, now, now);

        const row = db.prepare(\`
          SELECT COALESCE(SUM(reserved_tokens), 0) AS used
          FROM token_usage_ledger
          WHERE tenant_hash = ? AND status = 'RESERVED'
        \`).get(tenantHash);

        if (row.used + tokens > quota) {
          return false;
        }

        db.prepare(\`
          INSERT INTO token_usage_ledger
            (tenant_hash, request_id, reserved_tokens, actual_tokens, status, created_at, updated_at)
          VALUES (?, ?, ?, NULL, 'RESERVED', ?, ?)
        \`).run(tenantHash, reqId, tokens, now, now);
        return true;
      });

      const allowed = reserveTx.immediate(workerData.requestId, workerData.tokens, workerData.quota);
      db.close();
      parentPort.postMessage({ allowed });
    `;

    const spawnReservationWorker = (idx: number): Promise<boolean> =>
      new Promise((resolvePromise, rejectPromise) => {
        const worker = new Worker(workerScript, {
          eval: true,
          workerData: {
            dbPath,
            apiKey: 'sk-parallel-worker-tenant',
            requestId: `req_worker_${idx}`,
            tokens: 30_000,
            quota: 50_000,
          },
        });
        worker.once('message', (msg: { allowed: boolean }) => {
          resolvePromise(msg.allowed);
        });
        worker.once('error', rejectPromise);
      });

    // Two parallel threads simultaneously requesting 30,000 tokens each against a 50,000 quota:
    // combined = 60,000 > 50,000, so strictly ONE thread may succeed.
    const results = await Promise.all([
      spawnReservationWorker(1),
      spawnReservationWorker(2),
      spawnReservationWorker(3),
      spawnReservationWorker(4),
    ]);

    const passedCount = results.filter(Boolean).length;
    expect(passedCount).toBe(1);
  });

  it('enforces a 100-token/min remaining quota across 10 simultaneous HTTP requests without invoking providers on rejected requests', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'quill-task4-http-conc-100-'));
    tempDirs.push(dir);
    const dbPath = join(dir, 'http-concurrent-100.sqlite');
    const db = openRouterDatabase({ dbPath });

    try {
      const quotaLimit = 100;
      const limiter = new SlidingWindowLimiter({
        db,
        quotaLimit,
        windowMs: 60_000,
      });

      // 75ms simulated upstream latency ensures all 10 simultaneous HTTP requests
      // overlap in-flight while accepted rows are still in status = 'RESERVED'.
      const primaryProvider = new MockPrimaryProvider({ simulatedLatencyMs: 75 });
      const secondaryProvider = new MockSecondaryProvider();
      const tokenCounter = new TiktokenTokenCounter();

      const router = new ModelRouter({
        primaryProvider,
        secondaryProvider,
        limiter,
        tokenCounter,
        primaryTimeoutMs: 3_000,
        secondaryTimeoutMs: 3_000,
        defaultMaxTokens: 256,
        windowMs: 60_000,
      });

      const server = createModelRouterServer({ router, silentLogs: true });
      activeServers.push(server);
      const port = await server.listen(0, '127.0.0.1');
      const url = `http://127.0.0.1:${port}/v1/chat/completions`;
      const tenantApiKey = 'sk-audit-same-tenant-100';

      // Step 1: Consume 22 settled tokens first so remaining quota is 100 - 22 = 78 tokens.
      const warmupRes = await fetch(url, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          authorization: `Bearer ${tenantApiKey}`,
        },
        body: JSON.stringify({
          model: 'llama3.2:1b',
          max_tokens: 20,
          messages: [{ role: 'user', content: 'Hi' }],
        }),
      });
      expect(warmupRes.status).toBe(200);
      expect(limiter.getActiveTenantUsage(tenantApiKey)).toBe(22);
      expect(primaryProvider.invocationCount).toBe(1);

      // Step 2: Fire 10 simultaneous HTTP requests with the exact same tenant API key.
      // Prompt "Hi" = 8 tokens + max_tokens (30) = 38 reserved tokens per request.
      // Remaining quota = 78 -> strictly 2 concurrent requests fit (22 + 38 + 38 = 98 <= 100);
      // the other 8 concurrent requests (98 + 38 = 136 > 100) must all be rejected with HTTP 429.
      const burstResponses = await Promise.all(
        Array.from({ length: 10 }, () =>
          fetch(url, {
            method: 'POST',
            headers: {
              'content-type': 'application/json',
              authorization: `Bearer ${tenantApiKey}`,
            },
            body: JSON.stringify({
              model: 'llama3.2:1b',
              max_tokens: 30,
              messages: [{ role: 'user', content: 'Hi' }],
            }),
          }),
        ),
      );

      const okResponses = burstResponses.filter((r) => r.status === 200);
      const rateLimitedResponses = burstResponses.filter((r) => r.status === 429);

      expect(okResponses).toHaveLength(2);
      expect(rateLimitedResponses).toHaveLength(8);

      for (const rejectedRes of rateLimitedResponses) {
        expect(rejectedRes.headers.get('retry-after')).toBeTruthy();
        const errPayload = (await rejectedRes.json()) as StandardizedErrorPayload;
        expect(errPayload.error.code).toBe('RATE_LIMIT_EXCEEDED');
      }

      // Rejected requests MUST NOT invoke primary or secondary model providers:
      // total primary invocations = 1 warmup + 2 accepted burst requests = 3.
      expect(primaryProvider.invocationCount).toBe(3);
      expect(secondaryProvider.invocationCount).toBe(0);

      // Verify SQLite ledger integrity: zero duplicate request_ids, zero leaked RESERVED rows,
      // peak reservation sum during burst (22 settled + 2 * 38 reserved = 98) <= 100,
      // and final settled usage = 3 * 22 = 66 <= 100.
      const ledgerRows = db
        .prepare(
          `SELECT id, request_id, reserved_tokens, actual_tokens, status
           FROM token_usage_ledger
           WHERE tenant_hash = ?
           ORDER BY id ASC`,
        )
        .all(hashTenantApiKey(tenantApiKey)) as LedgerAuditRow[];

      expect(ledgerRows).toHaveLength(3);
      const uniqueRequestIds = new Set(ledgerRows.map((r) => r.request_id));
      expect(uniqueRequestIds.size).toBe(3);
      expect(ledgerRows.filter((r) => r.status === 'RESERVED')).toHaveLength(0);
      expect(ledgerRows.every((r) => r.status === 'SETTLED' && r.actual_tokens === 22)).toBe(true);

      const burstReservedSum = ledgerRows
        .slice(1)
        .reduce((acc, row) => acc + row.reserved_tokens, 0);
      expect(22 + burstReservedSum).toBe(98);
      expect(22 + burstReservedSum).toBeLessThanOrEqual(quotaLimit);
      expect(limiter.getActiveTenantUsage(tenantApiKey)).toBe(66);
    } finally {
      db.close();
    }
  });

  it('prevents double reservations on failover and prevents reservation leaks on upstream errors or client disconnects', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'quill-task4-leak-audit-'));
    tempDirs.push(dir);
    const dbPath = join(dir, 'leak-audit.sqlite');
    const db = openRouterDatabase({ dbPath });

    try {
      const limiter = new SlidingWindowLimiter({
        db,
        quotaLimit: 100,
        windowMs: 60_000,
      });

      const primaryProvider = new MockPrimaryProvider({
        simulatedLatencyMs: 60,
        timeoutScenarioLatencyMs: 250,
      });
      const secondaryProvider = new MockSecondaryProvider({ simulatedLatencyMs: 20 });

      const router = new ModelRouter({
        primaryProvider,
        secondaryProvider,
        limiter,
        tokenCounter: new TiktokenTokenCounter(),
        primaryTimeoutMs: 90,
        secondaryTimeoutMs: 500,
        defaultMaxTokens: 256,
        windowMs: 60_000,
      });

      const server = createModelRouterServer({ router, silentLogs: true });
      activeServers.push(server);
      const port = await server.listen(0, '127.0.0.1');
      const url = `http://127.0.0.1:${port}/v1/chat/completions`;
      const tenantApiKey = 'sk-audit-leak-check';

      // Launch 3 simultaneous requests within the 100-token ceiling (each reserves 8 + 20 = 28, sum = 84 <= 100):
      // 1) primary_429 -> fails over to secondary (must NOT double-reserve; settles once at 24 tokens)
      // 2) primary_500 -> non-retryable 502 (must release reservation -> actual_tokens = 0)
      // 3) both_unavailable -> primary 429 + secondary 503 -> 503 (must release reservation -> actual_tokens = 0)
      const [failoverRes, err500Res, bothDownRes] = await Promise.all([
        fetch(url, {
          method: 'POST',
          headers: {
            'content-type': 'application/json',
            authorization: `Bearer ${tenantApiKey}`,
          },
          body: JSON.stringify({
            model: 'llama3.2:1b',
            max_tokens: 20,
            mock_scenario: 'primary_429',
            messages: [{ role: 'user', content: 'Hi' }],
          }),
        }),
        fetch(url, {
          method: 'POST',
          headers: {
            'content-type': 'application/json',
            authorization: `Bearer ${tenantApiKey}`,
          },
          body: JSON.stringify({
            model: 'llama3.2:1b',
            max_tokens: 20,
            mock_scenario: 'primary_500',
            messages: [{ role: 'user', content: 'Hi' }],
          }),
        }),
        fetch(url, {
          method: 'POST',
          headers: {
            'content-type': 'application/json',
            authorization: `Bearer ${tenantApiKey}`,
          },
          body: JSON.stringify({
            model: 'llama3.2:1b',
            max_tokens: 20,
            mock_scenario: 'both_unavailable',
            messages: [{ role: 'user', content: 'Hi' }],
          }),
        }),
      ]);

      expect(failoverRes.status).toBe(200);
      expect(err500Res.status).toBe(502);
      expect(bothDownRes.status).toBe(503);

      // Also verify client mid-stream disconnect releases its reservation without leaking
      const disconnectAc = new AbortController();
      const disconnectPromise = fetch(url, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          authorization: `Bearer ${tenantApiKey}`,
        },
        body: JSON.stringify({
          model: 'llama3.2:1b',
          max_tokens: 20,
          messages: [{ role: 'user', content: 'Hi' }],
        }),
        signal: disconnectAc.signal,
      }).catch(() => null);

      await new Promise((r) => setTimeout(r, 15));
      disconnectAc.abort();
      await disconnectPromise;

      // Wait briefly for server disconnect cleanup handler to finish releasing reservation
      const deadline = Date.now() + 1000;
      while (Date.now() < deadline) {
        const pending = db
          .prepare(
            `SELECT COUNT(*) AS count FROM token_usage_ledger WHERE tenant_hash = ? AND status = 'RESERVED'`,
          )
          .get(hashTenantApiKey(tenantApiKey)) as { count: number };
        if (pending.count === 0) {
          break;
        }
        await new Promise((r) => setTimeout(r, 15));
      }

      const rows = db
        .prepare(
          `SELECT id, request_id, reserved_tokens, actual_tokens, status
           FROM token_usage_ledger
           WHERE tenant_hash = ?
           ORDER BY id ASC`,
        )
        .all(hashTenantApiKey(tenantApiKey)) as LedgerAuditRow[];

      // Strictly 4 rows (1 per request, zero double reservations even on primary -> secondary failover)
      expect(rows).toHaveLength(4);
      expect(new Set(rows.map((r) => r.request_id)).size).toBe(4);

      // Zero stuck RESERVED rows (zero reservation leaks)
      expect(rows.filter((r) => r.status === 'RESERVED')).toHaveLength(0);
      expect(rows.filter((r) => r.status === 'SETTLED')).toHaveLength(1);
      expect(rows.filter((r) => r.status === 'RELEASED')).toHaveLength(3);
      expect(rows.filter((r) => r.status === 'RELEASED').every((r) => r.actual_tokens === 0)).toBe(
        true,
      );

      // Only the single successful failover completion (24 tokens) counts against active tenant quota
      expect(limiter.getActiveTenantUsage(tenantApiKey)).toBe(24);
    } finally {
      db.close();
    }
  });
});
