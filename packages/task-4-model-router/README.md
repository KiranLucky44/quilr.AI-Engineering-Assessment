# Task 4: SQLite Token Rate Limiter & Model Failover Router (`@quill-ai/task-4-model-router`)

An HTTP LLM Gateway (`POST /v1/chat/completions` on port `4030`) implementing **per-tenant rolling 60-second token rate limiting** backed by an on-disk **SQLite WAL database** (`better-sqlite3`) and **cancellation-safe primary-to-secondary model failover**.

## Core Capabilities

1. **On-Disk SQLite WAL Persistence (`packages/task-4-model-router/data/model-router.sqlite`)**:
   - Configured with `journal_mode = WAL`, `busy_timeout = 5000`, `foreign_keys = ON`, and `STRICT` tables.
   - Tenants are identified via `Authorization: Bearer <api_key>`, hashed immediately with **SHA-256** (`64`-hex-character `tenant_hash`). Plaintext API keys are never persisted or logged.
2. **Atomic Sliding-Window Quota (`50,000` tokens / `60s`)**:
   - Server-side BPE token counting via `js-tiktoken` (`cl100k_base`) reserves `promptTokens + max_tokens` prior to upstream invocation.
   - Quota evaluation, expired-row eviction, and `RESERVED` row insertion execute inside a single **`BEGIN IMMEDIATE`** transaction, preventing concurrent bursts from exceeding a tenant's quota.
   - Reconciles to actual provider usage (`SETTLED`) on completion or releases (`RELEASED`) on upstream failure.
3. **Selective Model Failover**:
   - Invokes `MockPrimaryProvider` first with a `3,000ms` `AbortController` timeout.
   - Fails over to `MockSecondaryProvider` (single hop, no recursion) **exclusively** on **HTTP `429`** or **`>3,000ms` timeout** (cancelling the primary operation immediately on timeout).
   - Generic primary `500` errors do **not** trigger silent fallback and return a sanitized gateway error.

## Environment Variables

| Variable                      | Default                                                 | Description                                                                                                                     |
| ----------------------------- | ------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------- |
| `ROUTER_HOST`                 | `127.0.0.1`                                             | Host interface to bind                                                                                                          |
| `ROUTER_PORT`                 | `4030`                                                  | TCP port for the router gateway                                                                                                 |
| `ROUTER_DB_PATH`              | `packages/task-4-model-router/data/model-router.sqlite` | On-disk SQLite database file path                                                                                               |
| `ROUTER_WINDOW_MS`            | `60000`                                                 | Rolling sliding window duration in milliseconds                                                                                 |
| `ROUTER_TOKEN_QUOTA`          | `50000`                                                 | Maximum tokens per tenant per rolling window                                                                                    |
| `ROUTER_DEFAULT_MAX_TOKENS`   | `256`                                                   | Default completion reservation ceiling when `max_tokens` is omitted                                                             |
| `ROUTER_PRIMARY_TIMEOUT_MS`   | `3000`                                                  | Primary provider timeout before `AbortController` cancellation + failover                                                       |
| `ROUTER_SECONDARY_TIMEOUT_MS` | `3000`                                                  | Secondary failover provider timeout                                                                                             |
| `ROUTER_MAX_BODY_BYTES`       | `131072`                                                | Maximum incoming HTTP request body size in bytes                                                                                |
| `ROUTER_DEMO_SCENARIO`        | `success`                                               | Default demo scenario (`success`, `primary_429`, `primary_timeout`, `primary_500`, `secondary_unavailable`, `both_unavailable`) |

## Running & Testing

```bash
# Start the Model Router Gateway on http://127.0.0.1:4030
npm run dev:task4

# Run Task 4 SQLite, concurrency, rate-limiter, failover, and HTTP tests
npm run test:task4
```

## Copy-Pasteable `curl` Requests

### 1. Primary Provider Success (`HTTP 200`)

```bash
curl -s -X POST http://127.0.0.1:4030/v1/chat/completions \
  -H "Content-Type: application/json" \
  -H "Authorization: Bearer demo-tenant-alpha-key" \
  -d '{
    "model": "quill-enterprise-1",
    "max_tokens": 128,
    "messages": [{ "role": "user", "content": "Summarize system readiness." }]
  }'
```

### 2. Primary HTTP 429 -> Automatic Failover to Secondary (`HTTP 200`)

```bash
curl -s -X POST http://127.0.0.1:4030/v1/chat/completions \
  -H "Content-Type: application/json" \
  -H "Authorization: Bearer demo-tenant-alpha-key" \
  -d '{
    "model": "quill-enterprise-1",
    "max_tokens": 128,
    "mock_scenario": "primary_429",
    "messages": [{ "role": "user", "content": "Test 429 automatic failover." }]
  }'
```

### 3. Primary >3s Timeout -> Primary Cancelled + Secondary Failover (`HTTP 200`)

```bash
curl -s -X POST http://127.0.0.1:4030/v1/chat/completions \
  -H "Content-Type: application/json" \
  -H "Authorization: Bearer demo-tenant-alpha-key" \
  -d '{
    "model": "quill-enterprise-1",
    "max_tokens": 128,
    "mock_scenario": "primary_timeout",
    "messages": [{ "role": "user", "content": "Test 3000ms abort failover." }]
  }'
```

### 4. Both Providers Unavailable -> Standardized Sanitized Error (`HTTP 503`)

```bash
curl -s -X POST http://127.0.0.1:4030/v1/chat/completions \
  -H "Content-Type: application/json" \
  -H "Authorization: Bearer demo-tenant-alpha-key" \
  -d '{
    "model": "quill-enterprise-1",
    "max_tokens": 128,
    "mock_scenario": "both_unavailable",
    "messages": [{ "role": "user", "content": "Test total outage response." }]
  }'
```

Expected response:

```json
{
  "error": {
    "code": "MODEL_UNAVAILABLE",
    "message": "All model providers are currently unavailable.",
    "request_id": "req_..."
  }
}
```
