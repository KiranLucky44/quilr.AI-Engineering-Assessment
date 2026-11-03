-- Task 4: SQLite Sliding-Window Token Rate Limiter Schema
-- Plaintext API keys are NEVER stored; tenants are keyed strictly by 64-hex-char SHA-256 digests.

CREATE TABLE IF NOT EXISTS tenants (
  tenant_hash TEXT PRIMARY KEY NOT NULL CHECK (length(tenant_hash) = 64),
  created_at INTEGER NOT NULL,
  last_seen_at INTEGER NOT NULL
) STRICT;

CREATE TABLE IF NOT EXISTS token_usage_ledger (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  tenant_hash TEXT NOT NULL REFERENCES tenants(tenant_hash) ON DELETE CASCADE,
  request_id TEXT NOT NULL UNIQUE,
  reserved_tokens INTEGER NOT NULL CHECK (reserved_tokens > 0),
  actual_tokens INTEGER CHECK (actual_tokens IS NULL OR actual_tokens >= 0),
  status TEXT NOT NULL CHECK (status IN ('RESERVED', 'SETTLED', 'RELEASED')),
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
) STRICT;

CREATE INDEX IF NOT EXISTS idx_token_usage_tenant_window
  ON token_usage_ledger (tenant_hash, status, created_at);

