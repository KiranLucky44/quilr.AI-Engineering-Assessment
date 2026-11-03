import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { openRouterDatabase } from '../src/database/database.js';
import { SlidingWindowLimiter } from '../src/limiter/sliding-window-limiter.js';

describe('SQLite Database Initialization, Persistence & Secret Hygiene (Task 4)', () => {
  const tempDirs: string[] = [];

  afterEach(() => {
    while (tempDirs.length > 0) {
      const dir = tempDirs.pop();
      if (dir) {
        rmSync(dir, { recursive: true, force: true });
      }
    }
  });

  function createTempDbPath(): string {
    const dir = mkdtempSync(join(tmpdir(), 'quill-task4-db-'));
    tempDirs.push(dir);
    return join(dir, 'nested', 'model-router.sqlite');
  }

  it('creates an on-disk SQLite database with WAL mode, foreign keys, and busy timeout enabled', () => {
    const dbPath = createTempDbPath();
    const db = openRouterDatabase({ dbPath, busyTimeoutMs: 4500 });

    expect(existsSync(dbPath)).toBe(true);
    expect(db.pragma('journal_mode', { simple: true })).toBe('wal');
    expect(db.pragma('foreign_keys', { simple: true })).toBe(1);
    expect(db.pragma('busy_timeout', { simple: true })).toBe(4500);

    db.close();
  });

  it('persists settled tenant token usage across application restarts', () => {
    const dbPath = createTempDbPath();
    const secretApiKey = 'sk-live-super-sensitive-tenant-key-alpha-999';
    const fixedNow = 1_770_000_000_000;

    // First process lifecycle
    const db1 = openRouterDatabase({ dbPath });
    const limiter1 = new SlidingWindowLimiter({
      db: db1,
      quotaLimit: 50_000,
      windowMs: 60_000,
      clock: () => fixedNow,
    });

    const r1 = limiter1.tryReserveTokens(secretApiKey, 'req_restart_1', 35_000);
    expect(r1.allowed).toBe(true);
    limiter1.settleReservation('req_restart_1', 32_000);
    db1.close();

    // Second process lifecycle (simulated restart 10 seconds later)
    const db2 = openRouterDatabase({ dbPath });
    const limiter2 = new SlidingWindowLimiter({
      db: db2,
      quotaLimit: 50_000,
      windowMs: 60_000,
      clock: () => fixedNow + 10_000,
    });

    expect(limiter2.getActiveTenantUsage(secretApiKey)).toBe(32_000);

    // Requesting 20,000 more must be rejected because 32,000 + 20,000 > 50,000
    const r2 = limiter2.tryReserveTokens(secretApiKey, 'req_restart_2', 20_000);
    expect(r2.allowed).toBe(false);
    db2.close();
  });

  it('never persists plaintext tenant API keys anywhere in SQLite database files', () => {
    const dbPath = createTempDbPath();
    const plaintextKey = 'sk-plaintext-canary-credential-do-not-persist-847261';

    const db = openRouterDatabase({ dbPath });
    const limiter = new SlidingWindowLimiter({ db, quotaLimit: 50_000 });
    const res = limiter.tryReserveTokens(plaintextKey, 'req_canary_1', 1000);
    expect(res.allowed).toBe(true);
    limiter.settleReservation('req_canary_1', 850);
    db.pragma('wal_checkpoint(FULL)');
    db.close();

    const rawDbBytes = readFileSync(dbPath, 'latin1');
    expect(rawDbBytes).not.toContain(plaintextKey);
  });
});
