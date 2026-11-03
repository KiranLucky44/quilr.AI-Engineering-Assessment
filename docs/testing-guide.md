# Testing Guide

The automated verification suite uses **Vitest** (`v3.2.7`) and contains **91 automated tests across 18 test files** spanning unit, protocol, boundary, concurrency, fault-injection, and live HTTP/stdio integration suites.

## Test Execution Matrix

| Command              | Scope                     | Key Assertions Verified                                                                                                                                                                                  |
| -------------------- | ------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `npm run test`       | All 4 packages            | Complete monorepo test suite                                                                                                                                                                             |
| `npm run test:task1` | Task 1 MCP Server         | Strict Zod schemas, customer/refund determinism, real subprocess `StdioClientTransport`, `-32602` Invalid Params, zero `stdout` pollution                                                                |
| `npm run test:task2` | Task 2 Security Gateway   | Constant-time Bearer auth, `401` handling, `admin_*` RBAC (`-32001`), zero downstream leakage on unauthorized calls, notifications, batch rejection, timeouts                                            |
| `npm run test:task3` | Task 3 Streaming Redactor | Exhaustive every-index 2-chunk & 3-chunk splits for Email/SSN/Card, 1-char chunks, `250k+` char $O(1)$ bounded buffer check, OpenAI SSE framing, client disconnect cancellation                          |
| `npm run test:task4` | Task 4 Model Router       | On-disk WAL SQLite creation, restart persistence, binary check for zero plaintext keys, `BEGIN IMMEDIATE` multi-connection & `worker_threads` burst protection, fast fake-timer `3,000ms` abort failover |

## Running the Full Verification Pipeline

```bash
npm run verify
```

`npm run verify` runs five sequential gates and fails immediately if any check fails:

1. `npm run build` — Compiles all four workspaces with `tsc` (`tsconfig.build.json`).
2. `npm run typecheck` — Typechecks all `src/` and `tests/` files under strict TypeScript settings.
3. `npm run lint` — Runs ESLint `strictTypeChecked` rules (including `'no-console': 'error'` on Task 1).
4. `npm run format:check` — Verifies consistent formatting with Prettier.
5. `npm run test` — Executes all 18 Vitest suites.

## Deterministic & Fast Test Design

- **Zero External Credentials**: All tests run locally against deterministic mock providers and seeded synthetic fixtures.
- **Injectable Clocks & Fake Timers**: Task 4's `SlidingWindowLimiter` accepts an injectable `clock: () => number`, testing 60-second window roll-off in `< 5ms`. Task 4's `3,000ms` primary timeout test uses `vi.useFakeTimers()` + `vi.advanceTimersByTimeAsync(3_000)` to prove `AbortController` cancellation without sleeping 3 real wall-clock seconds.
- **Isolated On-Disk SQLite Fixtures**: Task 4 tests allocate per-test temporary directories under `os.tmpdir()` and clean them up in `afterEach`.
