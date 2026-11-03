import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Worker } from 'node:worker_threads';
import { afterEach, describe, expect, it } from 'vitest';
import { openRouterDatabase } from '../src/database/database.js';
import { SlidingWindowLimiter } from '../src/limiter/sliding-window-limiter.js';

describe('Atomic Concurrency Protection (BEGIN IMMEDIATE) (Task 4)', () => {
  const tempDirs: string[] = [];

  afterEach(() => {
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
});
