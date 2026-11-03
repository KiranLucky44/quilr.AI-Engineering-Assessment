import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { openRouterDatabase } from '../src/database/database.js';
import { GatewayError } from '../src/errors/gateway-errors.js';
import { SlidingWindowLimiter } from '../src/limiter/sliding-window-limiter.js';

describe('SlidingWindowLimiter Rolling 60s Quota Semantics (Task 4)', () => {
  const tempDirs: string[] = [];

  afterEach(() => {
    while (tempDirs.length > 0) {
      const dir = tempDirs.pop();
      if (dir) {
        rmSync(dir, { recursive: true, force: true });
      }
    }
  });

  function setupLimiter(quotaLimit = 50_000): {
    limiter: SlidingWindowLimiter;
    advanceMs: (delta: number) => void;
    closeDb: () => void;
    dbPath: string;
  } {
    const dir = mkdtempSync(join(tmpdir(), 'quill-task4-rl-'));
    tempDirs.push(dir);
    const dbPath = join(dir, 'limiter.sqlite');
    const db = openRouterDatabase({ dbPath });
    let now = 1_770_000_000_000;

    const limiter = new SlidingWindowLimiter({
      db,
      quotaLimit,
      windowMs: 60_000,
      clock: () => now,
    });

    return {
      limiter,
      advanceMs: (delta: number) => {
        now += delta;
      },
      closeDb: () => {
        db.close();
      },
      dbPath,
    };
  }

  it('accepts requests below and at exact 50,000 quota boundary, and rejects 1 token above quota', () => {
    const { limiter, closeDb } = setupLimiter(50_000);

    const first = limiter.tryReserveTokens('tenant-a-key', 'req_1', 30_000);
    expect(first.allowed).toBe(true);

    const exactBoundary = limiter.tryReserveTokens('tenant-a-key', 'req_2', 20_000);
    expect(exactBoundary.allowed).toBe(true);
    if (exactBoundary.allowed) {
      expect(exactBoundary.remainingTokens).toBe(0);
    }

    const overBoundary = limiter.tryReserveTokens('tenant-a-key', 'req_3', 1);
    expect(overBoundary.allowed).toBe(false);
    if (!overBoundary.allowed) {
      expect(overBoundary.currentUsageTokens).toBe(50_000);
      expect(overBoundary.retryAfterMs).toBe(60_000);
    }

    closeDb();
  });

  it('isolates quotas independently across distinct tenants', () => {
    const { limiter, closeDb } = setupLimiter(50_000);

    expect(limiter.tryReserveTokens('tenant-alpha', 'req_a1', 50_000).allowed).toBe(true);
    expect(limiter.tryReserveTokens('tenant-alpha', 'req_a2', 100).allowed).toBe(false);

    // Tenant beta has a completely independent 50,000 budget
    const betaRes = limiter.tryReserveTokens('tenant-beta', 'req_b1', 45_000);
    expect(betaRes.allowed).toBe(true);

    closeDb();
  });

  it('expires settled usage outside the rolling 60-second window while retaining active reservations', () => {
    const { limiter, advanceMs, closeDb } = setupLimiter(50_000);

    // T = 0s: reserve & settle 40,000 tokens
    expect(limiter.tryReserveTokens('tenant-window', 'req_t0', 45_000).allowed).toBe(true);
    limiter.settleReservation('req_t0', 40_000);

    // T = +30s: reserve 10,000 in-flight (not yet settled) -> active total = 50,000
    advanceMs(30_000);
    expect(limiter.tryReserveTokens('tenant-window', 'req_t30', 10_000).allowed).toBe(true);
    expect(limiter.tryReserveTokens('tenant-window', 'req_blocked', 5_000).allowed).toBe(false);

    // T = +60.001s: req_t0 (40,000 settled at T=0) has aged out of the 60s window!
    // Active in-flight req_t30 (10,000) still counts -> 40,000 budget now available.
    advanceMs(30_001);
    const afterExpiry = limiter.tryReserveTokens('tenant-window', 'req_t60', 35_000);
    expect(afterExpiry.allowed).toBe(true);
    if (afterExpiry.allowed) {
      expect(afterExpiry.activeWindowTokens).toBe(45_000);
    }

    closeDb();
  });

  it('reconciles overestimated reservations downward on settlement and frees failed reservations', () => {
    const { limiter, closeDb } = setupLimiter(10_000);

    // Reserve full 10,000 tokens, then settle actual usage at 2,000
    expect(limiter.tryReserveTokens('tenant-reconcile', 'req_r1', 10_000).allowed).toBe(true);
    limiter.settleReservation('req_r1', 2_000);
    expect(limiter.getActiveTenantUsage('tenant-reconcile')).toBe(2_000);

    // Reserve remaining 8,000, then release due to upstream failure
    expect(limiter.tryReserveTokens('tenant-reconcile', 'req_r2', 8_000).allowed).toBe(true);
    limiter.releaseReservation('req_r2');
    expect(limiter.getActiveTenantUsage('tenant-reconcile')).toBe(2_000);

    closeDb();
  });

  it('sanitizes SQLite database failures without leaking filesystem paths or SQL internals', () => {
    const { limiter, closeDb, dbPath } = setupLimiter(50_000);
    closeDb(); // Force underlying SQLite connection closed to trigger internal DB error

    expect(() => limiter.tryReserveTokens('tenant-err', 'req_db_err', 500)).toThrowError(
      GatewayError,
    );

    try {
      limiter.tryReserveTokens('tenant-err', 'req_db_err_2', 500);
    } catch (err) {
      expect(err).toBeInstanceOf(GatewayError);
      const gwErr = err as GatewayError;
      expect(gwErr.code).toBe('MODEL_UNAVAILABLE');
      expect(gwErr.message).not.toContain(dbPath);
      expect(gwErr.message).not.toContain('sqlite');
      expect(gwErr.message).not.toContain('token_usage_ledger');
    }
  });
});
