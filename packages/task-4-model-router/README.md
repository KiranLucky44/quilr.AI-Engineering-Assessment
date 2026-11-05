# Task 4: SQLite Token Rate Limiter & Model Failover Router (`@quill-ai/task-4-model-router`)

An HTTP LLM Gateway (`POST /v1/chat/completions` on port `4030`) implementing **per-tenant rolling 60-second token rate limiting** backed by an on-disk **SQLite WAL database** (`better-sqlite3`) and **cancellation-safe primary-to-secondary model failover**.

Supports both **deterministic mock providers** (with fault injection for HTTP `429`, `>3s` timeout, `500`, and total-outage testing) and **real OpenAI-compatible HTTP providers** (`OpenAICompatibleModelProvider`, including local **Ollama** models with zero paid API keys), independently configurable for Primary and Secondary slots.

## Core Capabilities

1. **On-Disk SQLite WAL Persistence (`packages/task-4-model-router/data/model-router.sqlite`)**:
   - Configured with `journal_mode = WAL`, `busy_timeout = 5000`, `foreign_keys = ON`, and `STRICT` tables.
   - Tenants are identified via `Authorization: Bearer <api_key>`, hashed immediately with **SHA-256** (`64`-hex-character `tenant_hash`). Plaintext API keys are never persisted or logged.
2. **Atomic Sliding-Window Quota (`50,000` tokens / `60s`)**:
   - Server-side BPE token counting via `js-tiktoken` (`cl100k_base`) reserves `promptTokens + max_tokens` prior to upstream invocation.
   - Quota evaluation, expired-row eviction, and `RESERVED` row insertion execute inside a single **`BEGIN IMMEDIATE`** transaction, preventing concurrent bursts from exceeding a tenant's quota.
   - Reconciles to actual provider `usage.total_tokens` (`SETTLED`) on completion (or `js-tiktoken` count if upstream omits `usage`) and releases (`RELEASED`) on upstream failure.
3. **Selective Model Failover & Pluggable Providers**:
   - Invokes Primary (`MockPrimaryProvider` or `OpenAICompatibleModelProvider`) first with an `AbortController` timeout (`3,000ms` default, configurable via `ROUTER_PRIMARY_TIMEOUT_MS`).
   - Fails over to Secondary (`MockSecondaryProvider` or `OpenAICompatibleModelProvider`, single hop, no recursion) **exclusively** on **HTTP `429`** or **timeout** (aborting the in-flight primary HTTP request immediately).
   - Non-retryable upstream errors (`500`, connection refused, malformed upstream JSON) release the SQLite reservation and return sanitized `MODEL_UNAVAILABLE` errors without leaking internal hostnames, URLs, or credentials.

## Installing Ollama & Pulling Models (Optional)

Automated tests use deterministic mocks + local in-process HTTP test servers by default and **do not** require Ollama. To demonstrate routing against genuine local LLMs:

```bash
# Install Ollama (Windows / macOS / Linux)
winget install Ollama.Ollama      # Windows
brew install ollama               # macOS
curl -fsSL https://ollama.com/install.sh | sh  # Linux

# Start Ollama and pull a lightweight local model
ollama serve
ollama pull llama3.2:1b
```

## Environment Variables

Task 4 automatically loads the repository root `.env` file on startup (without overriding explicit shell environment variables).

| Variable                      | Default                                                 | Description                                                                                                   |
| ----------------------------- | ------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------- |
| `LLM_PROVIDER`                | `mock`                                                  | Global default provider mode (`mock`, `ollama`, or `openai-compatible`)                                       |
| `OLLAMA_BASE_URL`             | `http://127.0.0.1:11434/v1`                             | Default OpenAI-compatible base URL for Ollama                                                                 |
| `OLLAMA_MODEL`                | `llama3.2:1b`                                           | Default Ollama model when `mode=ollama`                                                                       |
| `ROUTER_PRIMARY_PROVIDER`     | _(inherits `LLM_PROVIDER`)_                             | Primary slot override: `mock`, `ollama`, or `openai-compatible`                                               |
| `ROUTER_PRIMARY_BASE_URL`     | _(inherits `OLLAMA_BASE_URL`)_                          | Primary HTTP provider base URL                                                                                |
| `ROUTER_PRIMARY_MODEL`        | _(inherits `OLLAMA_MODEL` when `ollama`)_               | Configured model identifier sent to Primary HTTP provider                                                     |
| `ROUTER_PRIMARY_API_KEY`      | _(unset)_                                               | Optional `Authorization: Bearer` token for Primary HTTP provider                                              |
| `ROUTER_SECONDARY_PROVIDER`   | _(inherits `LLM_PROVIDER`)_                             | Secondary failover slot override: `mock`, `ollama`, or `openai-compatible`                                    |
| `ROUTER_SECONDARY_BASE_URL`   | _(inherits `OLLAMA_BASE_URL`)_                          | Secondary HTTP provider base URL                                                                              |
| `ROUTER_SECONDARY_MODEL`      | _(inherits `OLLAMA_MODEL` when `ollama`)_               | Configured model identifier sent to Secondary HTTP provider                                                   |
| `ROUTER_SECONDARY_API_KEY`    | _(unset)_                                               | Optional `Authorization: Bearer` token for Secondary HTTP provider                                            |
| `ROUTER_HOST`                 | `127.0.0.1`                                             | Host interface to bind                                                                                        |
| `ROUTER_PORT`                 | `4030`                                                  | TCP port for the router gateway                                                                               |
| `ROUTER_DB_PATH`              | `packages/task-4-model-router/data/model-router.sqlite` | On-disk SQLite database file path                                                                             |
| `ROUTER_WINDOW_MS`            | `60000`                                                 | Rolling sliding window duration in milliseconds                                                               |
| `ROUTER_TOKEN_QUOTA`          | `50000`                                                 | Maximum tokens per tenant per rolling window                                                                  |
| `ROUTER_DEFAULT_MAX_TOKENS`   | `256`                                                   | Default completion reservation ceiling when `max_tokens` is omitted                                           |
| `ROUTER_PRIMARY_TIMEOUT_MS`   | `3000`                                                  | Primary provider timeout before `AbortController` cancellation + failover                                     |
| `ROUTER_SECONDARY_TIMEOUT_MS` | `3000`                                                  | Secondary failover provider timeout                                                                           |
| `ROUTER_MAX_BODY_BYTES`       | `131072`                                                | Maximum incoming HTTP request body size in bytes                                                              |
| `ROUTER_DEMO_SCENARIO`        | `success`                                               | Mock fault-injection default (`success`, `primary_429`, `primary_timeout`, `primary_500`, `both_unavailable`) |

> **API Key Note:** Upstream API keys (`OLLAMA_API_KEY`, `ROUTER_PRIMARY_API_KEY`, `ROUTER_SECONDARY_API_KEY`) are **not required** for local Ollama or mock mode — leave them empty in `.env`. Incoming client requests to `:4030` include `Authorization: Bearer <any-tenant-label>` (for example `Bearer demo-tenant-1`) strictly as a local tenant identifier so `SlidingWindowLimiter` can isolate per-tenant token quotas in SQLite (stored only as a 64-character SHA-256 hash).

### Configuration Recipes (`.env`)

1. **Deterministic Mock Mode (Default)**:
   ```dotenv
   LLM_PROVIDER=mock
   ```
2. **Real Ollama Mode (Both Primary & Secondary)**:
   ```dotenv
   LLM_PROVIDER=ollama
   OLLAMA_BASE_URL=http://127.0.0.1:11434/v1
   OLLAMA_MODEL=llama3.2:1b
   ROUTER_PRIMARY_TIMEOUT_MS=15000
   ROUTER_SECONDARY_TIMEOUT_MS=15000
   ```
3. **Hybrid Fault-Injection -> Real Ollama Failover Demo** (Mock Primary injects `primary_429` or `primary_timeout`, failing over to a live local Ollama Secondary model):
   ```dotenv
   ROUTER_PRIMARY_PROVIDER=mock
   ROUTER_SECONDARY_PROVIDER=ollama
   OLLAMA_BASE_URL=http://127.0.0.1:11434/v1
   ROUTER_SECONDARY_MODEL=llama3.2:1b
   ROUTER_SECONDARY_TIMEOUT_MS=15000
   ```

## Running & Testing

### 1. Run Automated Tests Without Ollama (Default)

```bash
npm run test:task4
```

### 2. Run Opt-In Live Integration Tests Against Local Ollama

```bash
# Bash
OLLAMA_LIVE_TEST=true OLLAMA_MODEL=llama3.2:1b npm run test:task4
```

```powershell
# Windows PowerShell
$env:OLLAMA_LIVE_TEST="true"; $env:OLLAMA_MODEL="llama3.2:1b"; npm run test:task4; Remove-Item Env:OLLAMA_LIVE_TEST
```

### 3. Start the Router Server

```bash
npm run dev:task4
```

## API Request Examples

### 1. Primary Success (`Mock` or `Ollama` Mode)

**Bash:**

```bash
curl -s -X POST http://127.0.0.1:4030/v1/chat/completions \
  -H "Content-Type: application/json" \
  -H "Authorization: Bearer demo-tenant-alpha-key" \
  -d '{
    "model": "llama3.2:1b",
    "max_tokens": 128,
    "messages": [{ "role": "user", "content": "Summarize system readiness in one sentence." }]
  }'
```

**Windows PowerShell:**

```powershell
@'
{
  "model": "llama3.2:1b",
  "max_tokens": 128,
  "messages": [{ "role": "user", "content": "Summarize system readiness in one sentence." }]
}
'@ | curl.exe -s -X POST http://127.0.0.1:4030/v1/chat/completions -H "Content-Type: application/json" -H "Authorization: Bearer demo-tenant-alpha-key" --data-binary "@-"
```

### 2. Deterministic Fault Injection: Primary HTTP 429 -> Secondary Failover (`Mock` Primary)

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

### 3. Deterministic Fault Injection: Primary >3s Timeout -> Primary Cancelled + Secondary Failover (`Mock` Primary)

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

## Manual Rate-Limit Testing (`100` Tokens/Min Temporary Override)

By default, `ROUTER_TOKEN_QUOTA` is set to **`50000` tokens** per rolling `60000` ms (`60s`) window. Because shell environment variables take precedence over `.env`, you can temporarily test rate limiting with a `100`-token window in PowerShell without modifying `.env` or source code.

### How Reservation & Reconciliation Work

1. **Pre-Flight Atomic Reservation (`RESERVED`)**: Before contacting Primary or Secondary, `ModelRouter` estimates `reservedTokens = promptTokens + (max_tokens ?? ROUTER_DEFAULT_MAX_TOKENS)` using `js-tiktoken` (`cl100k_base`) and inserts a `RESERVED` ledger row inside a SQLite `BEGIN IMMEDIATE` transaction.
   - Because `ROUTER_DEFAULT_MAX_TOKENS` defaults to `256`, always pass a smaller `"max_tokens": 40` in your request payload when testing with a `100`-token quota; otherwise `promptTokens + 256` will exceed `100` on the very first request.
2. **Post-Generation Settlement (`SETTLED` / `RELEASED`)**:
   - On `200 OK`, the reservation transitions to `SETTLED` using actual `usage.total_tokens` (refunding unused `max_tokens` headroom back to the tenant's window).
   - On unrecoverable upstream failure, the reservation transitions to `RELEASED` (`actual_tokens = 0`) so failed upstream calls do not consume tenant quota.

### Step 1 — Free Port `4030` (If Already Running) & Restart with Quota `100`

If an earlier Task 4 instance is still listening on `127.0.0.1:4030`, starting a second copy will exit with `Fatal startup error in Task 4 Model Router` (`EADDRINUSE`). Stop any existing listener first, then set the session-scoped `100`-token quota:

```powershell
# Stop any existing process bound to TCP port 4030
Get-NetTCPConnection -LocalPort 4030 -State Listen -ErrorAction SilentlyContinue |
  ForEach-Object { Stop-Process -Id $_.OwningProcess -Force }

# Temporarily set a 100-token rolling 60s quota for this PowerShell session (.env stays at 50000)
$env:ROUTER_TOKEN_QUOTA = "100"
npm run dev:task4
```

Confirm the startup log on `stderr` displays `"tokenQuotaPerWindow":100,"windowMs":60000`.

### Step 2 — Trigger `200 OK` -> `429 RATE_LIMIT_EXCEEDED` (Windows PowerShell)

> **Windows PowerShell Quoting Tip:** Do not pass unescaped JSON variables directly via `--data-raw $body` in Windows PowerShell 5.1, which strips inner `"` quotes and causes `Malformed JSON` / `curl: (6) Could not resolve host` errors. Pipe JSON over stdin using `--data-binary "@-"` (or `@request.json`).

In a **second PowerShell terminal**, run the following request 3–4 times within 60 seconds:

```powershell
$body = '{"model":"llama3.2:1b","max_tokens":40,"messages":[{"role":"user","content":"Say hello briefly."}]}'

$body | curl.exe -i -X POST http://127.0.0.1:4030/v1/chat/completions `
  -H "Authorization: Bearer demo-tenant-1" `
  -H "Content-Type: application/json" `
  --data-binary "@-"
```

- **First 2–3 requests**: Succeed with `HTTP/1.1 200 OK` (settling ~22–30 tokens each).
- **Subsequent request within 60s**: Once `active_tokens + reservedTokens > 100`, returns `HTTP/1.1 429 Too Many Requests` with `retry-after: <seconds>` and `"code": "RATE_LIMIT_EXCEEDED"` without contacting any upstream model provider.

### Step 3 — Inspect Live Tenant Token Usage & SQLite Ledger

Because SQLite runs in `WAL` mode, you can inspect the tenant's active rolling-window usage and `token_usage_ledger` rows (`RESERVED`, `SETTLED`, `RELEASED`) while Task 4 is running (ensure `npm run build --workspace=@quill-ai/task-4-model-router` has been run at least once):

```powershell
@'
import { loadRouterConfig, openRouterDatabase, SlidingWindowLimiter, hashTenantApiKey } from './packages/task-4-model-router/dist/index.js';
process.chdir('packages/task-4-model-router');
const key = 'demo-tenant-1';
const cfg = loadRouterConfig();
const db = openRouterDatabase({ dbPath: cfg.dbPath });
const limiter = new SlidingWindowLimiter({ db, quotaLimit: cfg.tokenQuota, windowMs: cfg.windowMs });
console.log('Active rolling 60s tokens:', limiter.getActiveTenantUsage(key));
console.table(
  db.prepare(
    "SELECT request_id, reserved_tokens, actual_tokens, status, datetime(created_at/1000, 'unixepoch', 'localtime') AS time FROM token_usage_ledger WHERE tenant_hash = ? ORDER BY id DESC LIMIT 10"
  ).all(hashTenantApiKey(key))
);
db.close();
'@ | node --input-type=module -
```

### Step 4 — Restore the Default `50000` Assessment Quota

Stop Task 4 (`Ctrl+C`) in your server terminal, remove the temporary session override, and restart normally:

```powershell
Remove-Item Env:\ROUTER_TOKEN_QUOTA -ErrorAction SilentlyContinue
npm run dev:task4
```

Verify the startup log prints `"tokenQuotaPerWindow":50000` again.
