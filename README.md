# QuillAI Senior AI Infrastructure & Security Engineering Assessment (`quill-ai-engineering-assessment`)

## 1. Project Overview

`quill-ai-engineering-assessment` is a production-grade **Node.js 24 LTS / strict TypeScript ESM monorepo** implementing four independent AI infrastructure, Model Context Protocol (MCP), real-time guardrail, and LLM gateway systems.

Every service operates deterministically out-of-the-box on `localhost` with zero paid LLM API keys, zero external cloud dependencies, strict input/output validation, comprehensive automated test coverage, and sanitized error boundaries.

---

## 2. Assessment Objectives

Modern enterprise AI deployments require strong protocol boundaries, least-privilege tool governance, real-time sensitive data redaction across streaming token chunks, and atomic multi-tenant cost/rate controls with resilient model failover. This monorepo demonstrates:

- **Protocol Fidelity**: Genuine MCP JSON-RPC 2.0 over `stdio` (`stdout` protocol purity, `-32602` Invalid Params mapping) and HTTP reverse-proxy inspection.
- **Zero-Trust Security Controls**: Constant-time SHA-256 Bearer digest verification, pre-forwarding `admin_*` RBAC enforcement, credential stripping, and sanitized error envelopes.
- **Stateful Streaming Algorithms**: $O(1)$ bounded-memory (`256`-char ceiling) streaming PII redaction across arbitrary chunk splits with backpressure and disconnect cancellation.
- **Transactional Persistence & Resilience**: On-disk SQLite (`WAL` mode + `BEGIN IMMEDIATE`) rolling 60-second sliding-window token budgets paired with `AbortController`-driven primary-to-secondary failover.

---

## 3. Explanation of All Four Tasks

| Task       | Workspace Package                         | Summary                                                                                                                                                                                                                                                       |
| ---------- | ----------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Task 1** | `packages/task-1-mcp-server`              | Official `@modelcontextprotocol/sdk` (`v1.32.2`) stdio server exposing `get_customer_record` and simulated `trigger_refund` with `.strict()` Zod validation, `-32602` error mapping, and strict `stdout`/`stderr` isolation.                                  |
| **Task 2** | `packages/task-2-mcp-security-gateway`    | Native HTTP JSON-RPC 2.0 reverse proxy (`:4010/mcp`) authenticating `admin` and `viewer` Bearer tokens, blocking `viewer` calls to `admin_*` tools with `-32001` before reaching the downstream mock MCP server (`:4011/mcp`).                                |
| **Task 3** | `packages/task-3-llm-streaming-guardrail` | OpenAI-compatible SSE proxy (`:4020/v1/chat/completions`) performing stateful, bounded-buffer real-time redaction (`[REDACTED]`) of Email addresses, US SSNs, and Luhn-validated Credit/Debit cards across chunk boundaries.                                  |
| **Task 4** | `packages/task-4-model-router`            | HTTP LLM Gateway (`:4030/v1/chat/completions`) enforcing a `50,000`-token / `60s` per-tenant sliding window in on-disk SQLite (`better-sqlite3` WAL + `BEGIN IMMEDIATE`, SHA-256 tenant hashing) with `3,000ms` abort-safe failover on HTTP `429` or timeout. |

---

## 4. Main Architecture Diagram

```mermaid
flowchart TB
  subgraph Monorepo["quill-ai-engineering-assessment (npm workspaces)"]
    subgraph Task1["Task 1: Custom MCP Server (stdio)"]
      A1["MCP Client / Inspector"] <-->|"JSON-RPC 2.0 over stdin/stdout"| B1["McpServer v1.32.2\nget_customer_record | trigger_refund"]
      B1 -.->|"Diagnostics ONLY"| C1["process.stderr"]
    end

    subgraph Task2["Task 2: MCP Security Gateway (:4010 -> :4011)"]
      A2["Agent HTTP Client"] -->|"POST /mcp + Bearer"| B2["Security Gateway (:4010)\nSHA-256 timingSafeEqual + admin_* RBAC"]
      B2 -->|"Authorized JSON-RPC"| C2["Downstream Mock MCP (:4011)"]
    end

    subgraph Task3["Task 3: Streaming PII Redaction (:4020)"]
      A3["SSE Client"] <-->|"POST /v1/chat/completions\ntext/event-stream"| B3["StreamingRedactor\n<=256-char Bounded Buffer"]
      B3 <-->|"Normalized Deltas + AbortSignal"| C3["MockLLMProvider"]
    end

    subgraph Task4["Task 4: Token Limiter & Model Router (:4030)"]
      A4["Tenant Client"] -->|"POST /v1/chat/completions\nBearer API Key"| B4["ModelRouter + TiktokenCounter"]
      B4 <-->|"BEGIN IMMEDIATE (WAL)"| DB4[("SQLite On-Disk DB\nSHA-256 Tenant Hashes")]
      B4 -->|"1. Primary (3000ms AbortController)"| P4["MockPrimaryProvider"]
      B4 -.->|"2. Fallback ONLY on 429 / >3000ms"| S4["MockSecondaryProvider"]
    end
  end
```

---

## 5. Technology Stack

| Layer                | Technology / Package                                                            | Pinned Version                 |
| -------------------- | ------------------------------------------------------------------------------- | ------------------------------ |
| Runtime              | Node.js LTS (ESM `"type": "module"`)                                            | `>=24.0.0`                     |
| Language             | TypeScript (`strict`, `noUncheckedIndexedAccess`, `exactOptionalPropertyTypes`) | `5.9.3`                        |
| Schema Validation    | `zod`                                                                           | `3.25.76`                      |
| Task 1 MCP SDK       | `@modelcontextprotocol/sdk` (deliberately pinned v1.x)                          | `1.32.2`                       |
| HTTP & Streams       | Native `node:http`, Web `fetch`, `AbortController`, Async Generators            | Built-in                       |
| Task 4 Database      | `better-sqlite3` (N-API prebuilt, WAL mode)                                     | `13.0.3`                       |
| Task 4 Tokenizer     | `js-tiktoken` (`cl100k_base`)                                                   | `1.0.21`                       |
| Testing              | `vitest`                                                                        | `3.2.7`                        |
| Linting & Formatting | `eslint` + `typescript-eslint` (`strictTypeChecked`) + `prettier`               | `9.39.5` / `8.72.1` / `3.9.10` |
| Dev Runner & CI      | `tsx` + GitHub Actions (`.github/workflows/ci.yml`)                             | `4.23.15`                      |

---

## 6. Complete Repository Folder Structure

```text
quill-ai-engineering-assessment/
├── .editorconfig
├── .env.example
├── .gitignore
├── .prettierignore
├── .prettierrc.json
├── AGENTS.md
├── README.md
├── eslint.config.js
├── package-lock.json
├── package.json
├── tsconfig.json
├── vitest.config.ts
├── .github/
│   └── workflows/
│       └── ci.yml
├── docs/
│   ├── architecture.md
│   ├── security-considerations.md
│   ├── task-1-design.md
│   ├── task-2-design.md
│   ├── task-3-design.md
│   ├── task-4-design.md
│   └── testing-guide.md
└── packages/
    ├── task-1-mcp-server/
    │   ├── README.md
    │   ├── package.json
    │   ├── tsconfig.build.json
    │   ├── tsconfig.json
    │   ├── src/
    │   │   ├── index.ts
    │   │   ├── server.ts
    │   │   ├── config/logger.ts
    │   │   ├── data/mock-customers.ts
    │   │   ├── schemas/customer.schema.ts
    │   │   ├── schemas/refund.schema.ts
    │   │   ├── services/customer.service.ts
    │   │   └── services/refund.service.ts
    │   └── tests/
    │       ├── customer.test.ts
    │       ├── mcp.integration.test.ts
    │       ├── refund.test.ts
    │       └── schemas.test.ts
    ├── task-2-mcp-security-gateway/
    │   ├── README.md
    │   ├── package.json
    │   ├── tsconfig.build.json
    │   ├── tsconfig.json
    │   ├── src/
    │   │   ├── config.ts
    │   │   ├── downstream-mock.ts
    │   │   ├── gateway.ts
    │   │   ├── index.ts
    │   │   ├── auth/roles.ts
    │   │   ├── auth/token-verifier.ts
    │   │   ├── proxy/authorization-policy.ts
    │   │   ├── proxy/forwarder.ts
    │   │   └── proxy/request-validator.ts
    │   └── tests/
    │       ├── auth.test.ts
    │       ├── authorization.test.ts
    │       ├── jsonrpc.test.ts
    │       └── proxy.integration.test.ts
    ├── task-3-llm-streaming-guardrail/
    │   ├── README.md
    │   ├── package.json
    │   ├── tsconfig.build.json
    │   ├── tsconfig.json
    │   ├── src/
    │   │   ├── index.ts
    │   │   ├── server.ts
    │   │   ├── middleware/request-validator.ts
    │   │   ├── providers/llm-provider.interface.ts
    │   │   ├── providers/mock-llm.provider.ts
    │   │   ├── streaming/pii-patterns.ts
    │   │   ├── streaming/sse-encoder.ts
    │   │   └── streaming/streaming-redactor.ts
    │   └── tests/
    │       ├── chunk-boundary.test.ts
    │       ├── pii-patterns.test.ts
    │       ├── streaming-redactor.test.ts
    │       └── streaming.integration.test.ts
    └── task-4-model-router/
        ├── README.md
        ├── package.json
        ├── tsconfig.build.json
        ├── tsconfig.json
        ├── src/
        │   ├── config.ts
        │   ├── index.ts
        │   ├── server.ts
        │   ├── database/database.ts
        │   ├── database/schema.sql
        │   ├── errors/gateway-errors.ts
        │   ├── limiter/sliding-window-limiter.ts
        │   ├── limiter/token-counter.ts
        │   ├── providers/mock-primary.provider.ts
        │   ├── providers/mock-secondary.provider.ts
        │   ├── providers/model-provider.interface.ts
        │   ├── router/fallback-policy.ts
        │   └── router/model-router.ts
        └── tests/
            ├── concurrency.test.ts
            ├── database.test.ts
            ├── fallback.test.ts
            ├── rate-limiter.test.ts
            ├── router.integration.test.ts
            └── token-counter.test.ts
```

---

## 7. Prerequisites

- **Node.js**: `v24.0.0` or newer (verified on `v24.5.0` LTS)
- **npm**: `v10.0.0` or newer (verified on `v11.5.1`)
- **Git**: `v2.30+`
- No external databases, Docker containers, or paid API keys are required.

---

## 8. Installation Instructions

From the repository root:

```bash
npm install
npm run build
```

---

## 9. Environment Setup

All four packages include safe local defaults so they start immediately without any `.env` file. If you wish to customize ports, quotas, or demo tokens locally, copy `.env.example` (never commit `.env`):

```bash
cp .env.example .env
```

See `.env.example` and each package's `README.md` for the complete list of supported environment variables.

---

## 10. How to Run Each Task Independently

From the repository root:

```bash
# Task 1: Start MCP server over stdio
npm run dev:task1

# Task 2: Start MCP Security Gateway (:4010) + Downstream Mock (:4011)
npm run dev:task2

# Task 3: Start LLM Streaming PII Redaction Gateway (:4020)
npm run dev:task3

# Task 4: Start SQLite Token Limiter & Model Failover Router (:4030)
npm run dev:task4
```

Each package can also be started directly from its compiled `dist/` output after `npm run build`:

```bash
npm start --workspace=@quill-ai/task-1-mcp-server
npm start --workspace=@quill-ai/task-2-mcp-security-gateway
npm start --workspace=@quill-ai/task-3-llm-streaming-guardrail
npm start --workspace=@quill-ai/task-4-model-router
```

---

## 11. How to Run All Tests

```bash
# Run every test suite across all 4 tasks
npm run test

# Run individual task test suites
npm run test:task1
npm run test:task2
npm run test:task3
npm run test:task4
```

---

## 12. How to Run Type Checking

```bash
npm run typecheck
```

---

## 13. How to Run Linting & Formatting Checks

```bash
# Static analysis (ESLint strictTypeChecked)
npm run lint

# Formatting verification (Prettier)
npm run format:check

# Full end-to-end verification pipeline (build + typecheck + lint + format:check + test)
npm run verify
```

---

## 14. Example API Requests

### Task 1 (MCP over Stdio)

```bash
printf '%s\n' \
  '{"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":"2024-11-05","capabilities":{},"clientInfo":{"name":"cli","version":"1.0.0"}}}' \
  '{"jsonrpc":"2.0","method":"notifications/initialized"}' \
  '{"jsonrpc":"2.0","id":2,"method":"tools/call","params":{"name":"get_customer_record","arguments":{"customer_id":"CUST-12345"}}}' \
  | npm run --silent dev:task1
```

### Task 2 (MCP Security Gateway — Port `4010`)

```bash
curl -s -X POST http://127.0.0.1:4010/mcp \
  -H "Content-Type: application/json" \
  -H "Authorization: Bearer local-demo-admin-token-do-not-use-in-prod" \
  -d '{"jsonrpc":"2.0","id":"req-1","method":"tools/call","params":{"name":"admin_reset_key","arguments":{"tenant_id":"tenant-01"}}}'
```

### Task 3 (Streaming PII Redaction Gateway — Port `4020`)

```bash
curl -N -X POST http://127.0.0.1:4020/v1/chat/completions \
  -H "Content-Type: application/json" \
  -d '{"model":"quill-mock-gpt","stream":true,"mock_scenario":"email_three_chunk","messages":[{"role":"user","content":"Redact split email"}]}'
```

### Task 4 (SQLite Token Rate Limiter & Failover Router — Port `4030`)

```bash
curl -s -X POST http://127.0.0.1:4030/v1/chat/completions \
  -H "Content-Type: application/json" \
  -H "Authorization: Bearer demo-tenant-key-1" \
  -d '{"model":"quill-enterprise-1","max_tokens":128,"mock_scenario":"primary_429","messages":[{"role":"user","content":"Route with 429 failover"}]}'
```

---

## 15. Example Responses

### Task 2 Authorized `admin_reset_key` Response

```json
{
  "jsonrpc": "2.0",
  "id": "req-1",
  "result": {
    "content": [
      {
        "type": "text",
        "text": "{\"operation\":\"admin_reset_key\",\"tenant_id\":\"tenant-01\",\"key_version\":\"v2-rotated\",\"simulated\":true}"
      }
    ]
  }
}
```

### Task 3 Redacted SSE Stream Output

```text
data: {"id":"chatcmpl_mock_deterministic_01","object":"chat.completion.chunk","created":1769904000,"model":"quill-mock-gpt","system_fingerprint":"fp_quill_guardrail_v1","choices":[{"index":0,"delta":{"role":"assistant","content":""},"finish_reason":null}]}

data: {"id":"chatcmpl_mock_deterministic_01","object":"chat.completion.chunk","created":1769904000,"model":"quill-mock-gpt","system_fingerprint":"fp_quill_guardrail_v1","choices":[{"index":0,"delta":{"content":"Contact "},"finish_reason":null}]}

data: {"id":"chatcmpl_mock_deterministic_01","object":"chat.completion.chunk","created":1769904000,"model":"quill-mock-gpt","system_fingerprint":"fp_quill_guardrail_v1","choices":[{"index":0,"delta":{"content":"[REDACTED] regarding the "},"finish_reason":null}]}

data: {"id":"chatcmpl_mock_deterministic_01","object":"chat.completion.chunk","created":1769904000,"model":"quill-mock-gpt","system_fingerprint":"fp_quill_guardrail_v1","choices":[{"index":0,"delta":{"content":"request."},"finish_reason":null}]}

data: {"id":"chatcmpl_mock_deterministic_01","object":"chat.completion.chunk","created":1769904000,"model":"quill-mock-gpt","system_fingerprint":"fp_quill_guardrail_v1","choices":[{"index":0,"delta":{},"finish_reason":"stop"}]}

data: [DONE]
```

### Task 4 Secondary Failover Completion Response

```json
{
  "id": "chatcmpl_secondary_req_...",
  "object": "chat.completion",
  "created": 1769904000,
  "model": "quill-enterprise-1-fallback",
  "request_id": "req_...",
  "provider": "mock-secondary",
  "routed_via_fallback": true,
  "choices": [
    {
      "index": 0,
      "message": {
        "role": "assistant",
        "content": "Secondary failover model response (quill-enterprise-1-fallback): processed \"Route with 429 failover\""
      },
      "finish_reason": "stop"
    }
  ],
  "usage": {
    "prompt_tokens": 6,
    "completion_tokens": 18,
    "total_tokens": 24
  }
}
```

---

## 16. Example Error Responses

### Task 1 Invalid Tool Input (`-32602`)

```json
{
  "jsonrpc": "2.0",
  "id": 4,
  "error": {
    "code": -32602,
    "message": "MCP error -32602: Invalid arguments for tool \"get_customer_record\": customer_id: customer_id must match format ^CUST-[0-9]{5}$ (e.g., CUST-12345)"
  }
}
```

### Task 2 Viewer Blocked from `admin_*` Tool (`-32001`)

```json
{
  "jsonrpc": "2.0",
  "id": "call-blocked",
  "error": {
    "code": -32001,
    "message": "Unauthorized Tool Call"
  }
}
```

### Task 4 Rate Limit Exceeded (`HTTP 429`) & Total Provider Outage (`HTTP 503`)

```json
{
  "error": {
    "code": "RATE_LIMIT_EXCEEDED",
    "message": "Tenant token quota of 50000 tokens per rolling 60s window exceeded.",
    "request_id": "req_e4f8a912-...",
    "retry_after_ms": 48210
  }
}
```

```json
{
  "error": {
    "code": "MODEL_UNAVAILABLE",
    "message": "All model providers are currently unavailable.",
    "request_id": "req_91bc0421-..."
  }
}
```

---

## 17. Mock Credentials for Local Development

> **WARNING**: The values below are non-secret local-only fixtures for assessment verification. Never reuse static shared tokens in production environments.

- **Task 2 Admin Bearer Token**: `local-demo-admin-token-do-not-use-in-prod`
- **Task 2 Viewer Bearer Token**: `local-demo-viewer-token-do-not-use-in-prod`
- **Task 4 Tenant Bearer API Keys**: Any non-empty Bearer string (e.g., `demo-tenant-alpha-key`, `demo-tenant-beta-key`) identifies an isolated tenant bucket via its SHA-256 hash.

---

## 18. Default Port Numbers

| Service                      | Host        | Default Port           | Primary Endpoint            |
| ---------------------------- | ----------- | ---------------------- | --------------------------- |
| Task 1 Custom MCP Server     | `stdio`     | N/A (`stdin`/`stdout`) | JSON-RPC 2.0 over stdio     |
| Task 2 MCP Security Gateway  | `127.0.0.1` | `4010`                 | `POST /mcp`                 |
| Task 2 Downstream Mock MCP   | `127.0.0.1` | `4011`                 | `POST /mcp`, `GET /health`  |
| Task 3 Streaming PII Gateway | `127.0.0.1` | `4020`                 | `POST /v1/chat/completions` |
| Task 4 Model Router Gateway  | `127.0.0.1` | `4030`                 | `POST /v1/chat/completions` |

---

## 19. SQLite Database Explanation

Task 4 initializes a real on-disk SQLite database at runtime under `packages/task-4-model-router/data/model-router.sqlite` (ignored by `.gitignore`).

- **Pragmas**: `journal_mode = WAL`, `busy_timeout = 5000`, `foreign_keys = ON`, `synchronous = NORMAL`.
- **Tables (`STRICT`)**:
  - `tenants`: Stores `tenant_hash` (`CHECK (length(tenant_hash) = 64)`), `created_at`, and `last_seen_at`.
  - `token_usage_ledger`: Stores `id`, `tenant_hash` (`FOREIGN KEY ... ON DELETE CASCADE`), `request_id` (`UNIQUE`), `reserved_tokens`, `actual_tokens`, `status` (`RESERVED | SETTLED | RELEASED`), `created_at`, and `updated_at`, indexed by `(tenant_hash, status, created_at)`.

---

## 20. PII Redaction Explanation

`StreamingRedactor` (`packages/task-3-llm-streaming-guardrail/src/streaming/streaming-redactor.ts`) solves chunk-split PII leakage without full-response buffering:

1. **Bounded Holdback Window**: Enforces `MAX_HOLD_BUFFER_LENGTH = 256` characters (`254` max RFC email + `2` right-boundary lookahead chars) plus a `1`-character `lastInputChar` left-boundary context, guaranteeing $O(1)$ memory regardless of response size.
2. **Immediate Safe Flushing**: Characters preceding the earliest viable Email/SSN/Card suffix at the tail of the buffer are emitted immediately on the same chunk tick.
3. **Right-Boundary Extension Protection**: Complete matches touching the end of a chunk (such as `"john@gmail.co"` before `"m"` or `".uk"`, or 9 digits `"411111111"` before the remaining 7 digits of a 16-digit card) remain held until a non-extending delimiter arrives or `flush()` executes at stream completion.

---

## 21. Rate-Limiter Design Explanation

`SlidingWindowLimiter` (`packages/task-4-model-router/src/limiter/sliding-window-limiter.ts`) implements a two-phase **Reserve -> Settle/Release** ledger:

1. **Server-Side Token Counting**: `TiktokenTokenCounter` (`cl100k_base`) counts chat prompt tokens and adds requested `max_tokens` (or `ROUTER_DEFAULT_MAX_TOKENS`), ignoring any client-claimed usage.
2. **Atomic Write-Locked Reservation**: `reserveAtomicTx.immediate(...)` executes `BEGIN IMMEDIATE` so SQLite's write lock is acquired _before_ evicting expired rows (`created_at <= now - 60_000`) and summing active `SETTLED` + in-flight `RESERVED` tokens. Two simultaneous requests whose combined reservations exceed `50,000` tokens are serialized at the database lock level so at most one succeeds.
3. **Reconciliation**: Upon completion, `settleReservation` updates the row to `SETTLED` with authoritative provider `totalTokens` (or conservative BPE fallback). Failed upstream calls invoke `releaseReservation` (`RELEASED`, `actual_tokens = 0`), backed by a stale-reservation TTL sweep (`120s`) for crash recovery.

---

## 22. Security Limitations and Assumptions

- **Task 2 Development Token Map**: Static `ADMIN_TOKEN` / `VIEWER_TOKEN` environment mapping is purely a local assessment fixture. Production gateways should verify short-lived signed JWTs (OIDC/JWKS) with audience/issuer claims or mTLS workload certificates.
- **Local Plaintext Loopback**: Gateways bind to `127.0.0.1` over HTTP for zero-certificate local evaluation; production deployments require TLS 1.3 termination.
- **Simulated Refund & Key Rotation Actions**: All business side effects (`trigger_refund`, `admin_reset_key`, `admin_delete_customer`) are strictly deterministic in-memory simulations.

---

## 23. Known Limitations

- **Structured vs. Unstructured PII**: Task 3 deterministically redacts Emails, US SSNs, and Payment Card numbers; unstructured free-text entities (such as person names or physical street addresses) require a complementary NER model layer.
- **Single-Host SQLite Scope**: Task 4's WAL SQLite store coordinates concurrency across async requests, worker threads, and local processes sharing a filesystem, but horizontally scaled multi-host clusters require a networked store (e.g., Redis Lua or PostgreSQL).
- **JSON-RPC Batch Requests**: Task 2 intentionally rejects JSON-RPC batch arrays (`-32600`) to preserve unambiguous per-call RBAC enforcement and auditability.

---

## 24. Troubleshooting Guide

| Symptom                                                   | Cause                                                                                                    | Resolution                                                                                                       |
| --------------------------------------------------------- | -------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------- |
| `EADDRINUSE` on ports `4010`, `4011`, `4020`, or `4030`   | Another local process is already listening on the default port                                           | Override `GATEWAY_PORT`, `DOWNSTREAM_PORT`, `STREAMING_GATEWAY_PORT`, or `ROUTER_PORT` via environment variables |
| `better-sqlite3` load error after switching Node versions | Node ABI changed after `npm install`                                                                     | Ensure `node -v` is Node.js 24 LTS (`>=24.0.0`) and re-run `npm rebuild better-sqlite3` or `npm ci`              |
| `curl` buffers SSE output in Task 3                       | `curl` buffers output by default unless `-N` (`--no-buffer`) is passed                                   | Run `curl -N ...` to observe real-time SSE chunks as they arrive                                                 |
| Task 1 produces no output when started manually           | Task 1 uses MCP `stdio` transport and waits for JSON-RPC frames on `stdin` (startup logs go to `stderr`) | Pipe JSON-RPC lines to `stdin` (see Section 14) or attach `@modelcontextprotocol/inspector`                      |
