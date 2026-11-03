# Task 4 Design: SQLite Sliding-Window Token Rate Limiter & Model Failover Router

## Atomic Reservation & Failover Sequence

```mermaid
sequenceDiagram
  participant Client as Tenant HTTP Client
  participant GW as Model Router (:4030)
  participant Tok as TiktokenTokenCounter (cl100k_base)
  participant DB as SQLite WAL (BEGIN IMMEDIATE)
  participant P as MockPrimaryProvider (3000ms Abort)
  participant S as MockSecondaryProvider

  Client->>GW: POST /v1/chat/completions (Bearer API Key)
  GW->>Tok: estimateReservation(messages, max_tokens)
  GW->>DB: BEGIN IMMEDIATE -> Evict <= now-60s -> Sum RESERVED + SETTLED
  alt Usage + Reservation > 50,000
    DB-->>GW: { allowed: false, retryAfterMs }
    GW-->>Client: HTTP 429 RATE_LIMIT_EXCEEDED (Retry-After)
  else Quota Available
    DB-->>GW: INSERT status='RESERVED' -> COMMIT
    GW->>P: generateCompletion(req, primaryAbortSignal)
    alt Primary HTTP 200
      P-->>GW: Completion + Usage
      GW->>DB: UPDATE status='SETTLED', actual_tokens
      GW-->>Client: HTTP 200 (routed_via_fallback: false)
    else Primary HTTP 429 or >3000ms Timeout (AbortSignal cancelled)
      P--xGW: 429 or ProviderTimeoutError
      GW->>S: generateCompletion(req, secondaryAbortSignal)
      alt Secondary HTTP 200
        S-->>GW: Failover Completion + Usage
        GW->>DB: UPDATE status='SETTLED', actual_tokens
        GW-->>Client: HTTP 200 (routed_via_fallback: true)
      else Secondary Fails
        S--xGW: Error
        GW->>DB: UPDATE status='RELEASED', actual_tokens=0
        GW-->>Client: HTTP 503 MODEL_UNAVAILABLE (sanitized)
      end
    else Primary Generic HTTP 500 (Non-Retryable Policy)
      P--xGW: 500 Error
      GW->>DB: UPDATE status='RELEASED', actual_tokens=0
      GW-->>Client: HTTP 502 MODEL_UNAVAILABLE (no fallback)
    end
  end
```

## Key Architectural Invariants

1. **Why `BEGIN IMMEDIATE` Prevents Race Conditions**:
   Under SQLite's default `DEFERRED` transaction mode, two concurrent connections can both read `SUM(tokens) = 30,000` before either attempts an `INSERT`, allowing two `30,000`-token requests (`60,000 > 50,000`) to race or fail with `SQLITE_BUSY` mid-transaction. Executing `reserveAtomicTx.immediate(...)` issues `BEGIN IMMEDIATE`, acquiring SQLite's RESERVED write lock _before_ calculating active window usage (`busy_timeout = 5000` coordinates contention cleanly across connections and worker threads).
2. **SHA-256 Tenant Isolation**:
   API keys from `Authorization: Bearer <key>` are immediately hashed using SHA-256 (`64` lowercase hex characters) and enforced via `CHECK (length(tenant_hash) = 64)` in SQLite `STRICT` tables. Raw credentials never touch disk or logs.
3. **Reservation Reconciliation & Abandoned TTL**:
   - Pre-flight reservation reserves `promptTokens + max_tokens` using server-side `js-tiktoken` (`cl100k_base`).
   - On completion, `SETTLED` reconciles downward/upward to `provider.usage.totalTokens` (or a conservative local BPE estimate `promptTokens + max(1, countText(output))` when provider usage is absent).
   - On upstream failure, `RELEASED` sets `actual_tokens = 0` so upstream outages do not consume tenant quota. Stale `RESERVED` rows older than `staleReservationTtlMs` (`120s`) are automatically swept on subsequent reservations to handle abrupt process crashes.
4. **Cancellation-Safe Failover**:
   Primary timeout uses an `AbortController` timer that cancels the in-flight primary operation immediately at `3,000ms` rather than orphaning background promises via bare `Promise.race`.
