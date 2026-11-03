import { createHash } from 'node:crypto';
import type { Database as BetterSqliteDatabase, Statement, Transaction } from 'better-sqlite3';
import { GatewayError } from '../errors/gateway-errors.js';

export interface SlidingWindowLimiterOptions {
  readonly db: BetterSqliteDatabase;
  readonly windowMs?: number;
  readonly quotaLimit?: number;
  readonly staleReservationTtlMs?: number;
  readonly clock?: () => number;
}

export type ReservationOutcome =
  | {
      readonly allowed: true;
      readonly tenantHash: string;
      readonly requestId: string;
      readonly reservedTokens: number;
      readonly activeWindowTokens: number;
      readonly remainingTokens: number;
    }
  | {
      readonly allowed: false;
      readonly tenantHash: string;
      readonly currentUsageTokens: number;
      readonly requestedTokens: number;
      readonly quotaLimit: number;
      readonly retryAfterMs: number;
    };

interface WindowSummaryRow {
  readonly active_tokens: number;
  readonly oldest_active_created_at: number | null;
}

/**
 * Computes a deterministic 64-character SHA-256 hex digest of a tenant's API key.
 * Plaintext tenant credentials are never persisted to SQLite or logged.
 */
export function hashTenantApiKey(apiKey: string): string {
  return createHash('sha256').update(apiKey, 'utf8').digest('hex');
}

/**
 * SQLite-backed rolling 60-second token rate limiter with atomic `BEGIN IMMEDIATE`
 * write-locked reservation and post-generation reconciliation.
 */
export class SlidingWindowLimiter {
  private readonly db: BetterSqliteDatabase;
  private readonly windowMs: number;
  private readonly quotaLimit: number;
  private readonly staleReservationTtlMs: number;
  private readonly nowMs: () => number;

  private readonly upsertTenantStmt: Statement;
  private readonly evictExpiredSettledStmt: Statement;
  private readonly expireStaleReservationsStmt: Statement;
  private readonly sumActiveUsageStmt: Statement;
  private readonly insertReservationStmt: Statement;
  private readonly settleReservationStmt: Statement;
  private readonly releaseReservationStmt: Statement;

  private readonly reserveAtomicTx: Transaction<
    (tenantHash: string, requestId: string, tokensToReserve: number) => ReservationOutcome
  >;
  private readonly settleAtomicTx: Transaction<(requestId: string, actualTokens: number) => void>;
  private readonly releaseAtomicTx: Transaction<(requestId: string) => void>;

  public constructor(options: SlidingWindowLimiterOptions) {
    this.db = options.db;
    this.windowMs = options.windowMs ?? 60_000;
    this.quotaLimit = options.quotaLimit ?? 50_000;
    this.staleReservationTtlMs =
      options.staleReservationTtlMs ?? Math.max(this.windowMs * 2, 120_000);
    this.nowMs = options.clock ?? (() => Date.now());

    this.upsertTenantStmt = this.db.prepare(`
      INSERT INTO tenants (tenant_hash, created_at, last_seen_at)
      VALUES (@tenantHash, @now, @now)
      ON CONFLICT(tenant_hash) DO UPDATE SET last_seen_at = excluded.last_seen_at
    `);

    this.evictExpiredSettledStmt = this.db.prepare(`
      DELETE FROM token_usage_ledger
      WHERE status IN ('SETTLED', 'RELEASED')
        AND created_at <= @windowStart
    `);

    this.expireStaleReservationsStmt = this.db.prepare(`
      UPDATE token_usage_ledger
      SET status = 'RELEASED',
          actual_tokens = 0,
          updated_at = @now
      WHERE status = 'RESERVED'
        AND created_at <= @staleThreshold
    `);

    this.sumActiveUsageStmt = this.db.prepare(`
      SELECT
        COALESCE(SUM(
          CASE
            WHEN status = 'RESERVED' THEN reserved_tokens
            WHEN status = 'SETTLED' AND created_at > @windowStart THEN COALESCE(actual_tokens, reserved_tokens)
            ELSE 0
          END
        ), 0) AS active_tokens,
        MIN(
          CASE
            WHEN status = 'SETTLED' AND created_at > @windowStart THEN created_at
            WHEN status = 'RESERVED' THEN created_at
            ELSE NULL
          END
        ) AS oldest_active_created_at
      FROM token_usage_ledger
      WHERE tenant_hash = @tenantHash
        AND (status = 'RESERVED' OR (status = 'SETTLED' AND created_at > @windowStart))
    `);

    this.insertReservationStmt = this.db.prepare(`
      INSERT INTO token_usage_ledger (
        tenant_hash,
        request_id,
        reserved_tokens,
        actual_tokens,
        status,
        created_at,
        updated_at
      ) VALUES (
        @tenantHash,
        @requestId,
        @reservedTokens,
        NULL,
        'RESERVED',
        @now,
        @now
      )
    `);

    this.settleReservationStmt = this.db.prepare(`
      UPDATE token_usage_ledger
      SET status = 'SETTLED',
          actual_tokens = @actualTokens,
          updated_at = @now
      WHERE request_id = @requestId
        AND status = 'RESERVED'
    `);

    this.releaseReservationStmt = this.db.prepare(`
      UPDATE token_usage_ledger
      SET status = 'RELEASED',
          actual_tokens = 0,
          updated_at = @now
      WHERE request_id = @requestId
        AND status = 'RESERVED'
    `);

    this.reserveAtomicTx = this.db.transaction(
      (tenantHash: string, requestId: string, tokensToReserve: number): ReservationOutcome => {
        const now = this.nowMs();
        const windowStart = now - this.windowMs;
        const staleThreshold = now - this.staleReservationTtlMs;

        this.evictExpiredSettledStmt.run({ windowStart });
        this.expireStaleReservationsStmt.run({ now, staleThreshold });
        this.upsertTenantStmt.run({ tenantHash, now });

        const summary = this.sumActiveUsageStmt.get({
          tenantHash,
          windowStart,
        }) as WindowSummaryRow;

        const currentUsage = summary.active_tokens;
        if (currentUsage + tokensToReserve > this.quotaLimit) {
          const retryAfterMs =
            summary.oldest_active_created_at !== null
              ? Math.max(1, summary.oldest_active_created_at + this.windowMs - now)
              : this.windowMs;

          return {
            allowed: false,
            tenantHash,
            currentUsageTokens: currentUsage,
            requestedTokens: tokensToReserve,
            quotaLimit: this.quotaLimit,
            retryAfterMs,
          };
        }

        this.insertReservationStmt.run({
          tenantHash,
          requestId,
          reservedTokens: tokensToReserve,
          now,
        });

        const nextUsage = currentUsage + tokensToReserve;
        return {
          allowed: true,
          tenantHash,
          requestId,
          reservedTokens: tokensToReserve,
          activeWindowTokens: nextUsage,
          remainingTokens: this.quotaLimit - nextUsage,
        };
      },
    );

    this.settleAtomicTx = this.db.transaction((requestId: string, actualTokens: number): void => {
      const now = this.nowMs();
      this.settleReservationStmt.run({
        requestId,
        actualTokens: Math.max(0, Math.trunc(actualTokens)),
        now,
      });
    });

    this.releaseAtomicTx = this.db.transaction((requestId: string): void => {
      const now = this.nowMs();
      this.releaseReservationStmt.run({
        requestId,
        now,
      });
    });
  }

  /**
   * Atomically evaluates rolling 60s quota + in-flight reservations and inserts a
   * `RESERVED` ledger row under SQLite `BEGIN IMMEDIATE` write serialization.
   */
  public tryReserveTokens(
    apiKey: string,
    requestId: string,
    tokensToReserve: number,
  ): ReservationOutcome {
    if (!Number.isSafeInteger(tokensToReserve) || tokensToReserve <= 0) {
      throw new GatewayError(
        'INVALID_REQUEST',
        400,
        'Token reservation amount must be a positive integer.',
      );
    }

    const tenantHash = hashTenantApiKey(apiKey);
    try {
      return this.reserveAtomicTx.immediate(tenantHash, requestId, tokensToReserve);
    } catch {
      throw new GatewayError(
        'MODEL_UNAVAILABLE',
        503,
        'Rate limiting service is temporarily unavailable.',
      );
    }
  }

  public settleReservation(requestId: string, actualTokens: number): void {
    try {
      this.settleAtomicTx.immediate(requestId, actualTokens);
    } catch {
      throw new GatewayError(
        'MODEL_UNAVAILABLE',
        503,
        'Rate limiting service failed to reconcile usage.',
      );
    }
  }

  public releaseReservation(requestId: string): void {
    try {
      this.releaseAtomicTx.immediate(requestId);
    } catch {
      // Best-effort cleanup on failed upstream calls; stale TTL acts as secondary safety net.
    }
  }

  public getActiveTenantUsage(apiKey: string): number {
    const tenantHash = hashTenantApiKey(apiKey);
    const now = this.nowMs();
    const windowStart = now - this.windowMs;

    try {
      const summary = this.sumActiveUsageStmt.get({
        tenantHash,
        windowStart,
      }) as WindowSummaryRow;
      return summary.active_tokens;
    } catch {
      throw new GatewayError(
        'MODEL_UNAVAILABLE',
        503,
        'Rate limiting service is temporarily unavailable.',
      );
    }
  }
}
