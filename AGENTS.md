# AGENTS.md — Repository Engineering Guidelines

This repository (`quill-ai-engineering-assessment`) is a four-package TypeScript/ESM monorepo implementing core AI infrastructure, MCP protocol tooling, security gateways, real-time PII guardrails, and SQLite-backed LLM rate limiting/routing.

## Architectural Boundaries

Each package under `packages/` is an **independent, standalone application**:

1. `packages/task-1-mcp-server` — Stdio MCP Server (`@modelcontextprotocol/sdk` v1.x)
2. `packages/task-2-mcp-security-gateway` — HTTP JSON-RPC Reverse Proxy (`:4010`) + Mock Downstream (`:4011`)
3. `packages/task-3-llm-streaming-guardrail` — OpenAI-Compatible SSE Streaming PII Redaction Proxy (`:4020`)
4. `packages/task-4-model-router` — SQLite Sliding-Window Token Rate Limiter & Failover Router (`:4030`)

Do **not** couple packages to one another via cross-package imports; keep each package independently buildable, runnable, and testable.

## Non-Negotiable Security & Protocol Invariants

- **Task 1 Stdio Purity**: Never call `console.log()` or write non-protocol text to `process.stdout` inside `packages/task-1-mcp-server`. `stdout` belongs exclusively to `StdioServerTransport` JSON-RPC 2.0 frames. Route all logs to `process.stderr` via `createStderrLogger`.
- **Credential Hygiene**: Never log, echo, or persist plaintext Bearer tokens or tenant API keys. Task 2 hashes tokens in memory and compares digests via `crypto.timingSafeEqual`; Task 4 persists only 64-character SHA-256 tenant digests in SQLite.
- **PII Memory Bounds**: Task 3 must maintain $O(1)$ bounded memory (`MAX_HOLD_BUFFER_LENGTH = 256` chars) per stream and never buffer full model responses before emitting safe deltas.
- **SQLite Concurrency**: Task 4 quota evaluation and reservation insertion must execute atomically inside a single `BEGIN IMMEDIATE` transaction (`reserveAtomicTx.immediate(...)`) on an on-disk WAL-enabled SQLite database.
- **Error Sanitization**: Never leak stack traces, internal filesystem paths, SQLite table names, or upstream hostnames in client-facing error payloads.

## Verification Workflow

Before finishing any change, run the full verification pipeline from the repository root:

```bash
npm run verify
```

This executes `build`, `typecheck`, `lint`, `format:check`, and `test` across all four workspaces.
