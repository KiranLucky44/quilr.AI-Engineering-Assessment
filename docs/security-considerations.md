# Security Considerations & Known Architectural Trade-Offs

## Threat Mitigations Implemented

| Threat Vector                                          | Control Implemented                                                                                               | Package(s)     |
| ------------------------------------------------------ | ----------------------------------------------------------------------------------------------------------------- | -------------- |
| **Parameter Pollution / Schema Smuggling**             | Strict Zod schemas (`.strict()`) rejecting unknown fields, `NaN`, `Infinity`, `null`, and untrimmed short strings | All            |
| **MCP Stdio Protocol Framing Injection**               | ESLint `no-console` enforcement + stderr-only JSON logger + raw `stdout` wire verification test                   | Task 1         |
| **Timing Side-Channels on Token Verification**         | SHA-256 pre-hashing + non-short-circuiting `crypto.timingSafeEqual` across role digests                           | Task 2         |
| **Unauthorized Tool Execution (`admin_*`)**            | Pre-forwarding RBAC interception returning JSON-RPC `-32001` before any socket reaches downstream                 | Task 2         |
| **Bearer Credential Leakage to Downstream / Logs**     | `Authorization` header stripped by `DownstreamForwarder`; plaintext tokens discarded at startup                   | Task 2, Task 4 |
| **Cross-Chunk Streaming PII Leakage**                  | Stateful bounded holdback buffer (`256` chars) + right-boundary extension sealing + Luhn/SSA validation           | Task 3         |
| **Memory Exhaustion via Oversized Payloads / Streams** | Streaming HTTP body limiters (`413 Payload Too Large`) + $O(1)$ sub-sliced redactor buffer                        | Task 2, 3, 4   |
| **TOCTOU Quota Bypass Under Concurrent Bursts**        | SQLite `WAL` mode + `BEGIN IMMEDIATE` write-serialized quota calculation & reservation                            | Task 4         |
| **Plaintext API Key Exposure at Rest**                 | 64-hex-char SHA-256 `tenant_hash` primary keys enforced via SQLite `STRICT` + `CHECK` constraints                 | Task 4         |
| **Information Disclosure via Error Responses**         | Standardized gateway error envelopes stripping stack traces, file paths, C++/SQLite details, and internal hosts   | All            |

## Explicit Limitations & Production Hardening Recommendations

1. **Task 2 Static Token Map**:
   Task 2 maps `ADMIN_TOKEN` and `VIEWER_TOKEN` from environment variables for deterministic local evaluation. Static shared bearer secrets lack per-user attribution, automatic expiration, and key rotation. In production, replace `TokenVerifier` with OIDC/OAuth 2.1 JWT verification backed by a cached JWKS endpoint or mutual TLS (mTLS) SPIFFE/SPIRE workload identities.
2. **Task 3 Pattern-Based PII Detection**:
   Deterministic regex + Luhn/SSA state machines achieve sub-millisecond latency and zero external model dependencies for structured identifiers (Emails, US SSNs, Payment Cards), but do not detect unstructured contextual PII (such as person names, street addresses, or free-form medical notes) or obfuscated encodings (e.g., Base64 or written-out digits `"four one one one..."`). Production guardrails typically pair fast deterministic regex redaction with lightweight local NER classifiers.
3. **Task 4 Single-Node SQLite Topology**:
   `better-sqlite3` with WAL mode and `BEGIN IMMEDIATE` provides true ACID serialization across threads and local processes sharing a host volume, making it ideal for single-node gateways or edge appliances. Multi-region horizontally scaled gateway fleets require a distributed atomic store (e.g., Redis Lua scripts or PostgreSQL advisory/row locks) for global tenant quotas.
4. **TLS Termination**:
   All local HTTP servers bind to `127.0.0.1` over plaintext HTTP for zero-config local evaluation. Production deployments must terminate TLS 1.3 at an ingress proxy or load balancer.
