# Task 2: MCP Security Gateway (`@quill-ai/task-2-mcp-security-gateway`)

An HTTP JSON-RPC 2.0 reverse proxy that authenticates AI agent callers via Bearer credentials and enforces role-based tool authorization (`admin` vs. `viewer`) in front of a downstream HTTP MCP server.

## Default Endpoints & Ports

- **Security Gateway**: `http://127.0.0.1:4010/mcp` (`GET /health` at `http://127.0.0.1:4010/health`)
- **Downstream Mock MCP Server**: `http://127.0.0.1:4011/mcp` (`GET /health` at `http://127.0.0.1:4011/health` exposes live invocation counters)

## Security & Protocol Policies

1. **Authentication**: Reads `Authorization: Bearer <token>`. Configured `ADMIN_TOKEN` and `VIEWER_TOKEN` are hashed with SHA-256 at startup and compared via `crypto.timingSafeEqual`. Plaintext tokens are never stored, logged, or forwarded downstream. Missing/invalid credentials return **HTTP `401 Unauthorized`**.
   > **Development Token Limitation**: Static environment token mapping is strictly for local evaluation. Production deployments must verify cryptographically signed short-lived OIDC/JWT tokens or mTLS client certificates.
2. **Authorization (`admin_*` Tool Guard)**:
   - `tools/list`: Transparently forwarded to the downstream server for both `viewer` and `admin`.
   - `tools/call`: Any tool whose `params.name` starts with `admin_` (e.g., `admin_reset_key`, `admin_delete_customer`, `admin_update_config`) requires the `admin` role. Unauthorized `viewer` calls are **blocked at the gateway** without contacting downstream and receive JSON-RPC error **`-32001` (`"Unauthorized Tool Call"`)** with the original request `id`.
3. **Batch & Notification Handling**:
   - Single JSON-RPC 2.0 requests and notifications (requests without `id`, returning `204 No Content`) are supported.
   - JSON-RPC batch arrays (`[...]`) are explicitly rejected with `-32600 Invalid Request` (`HTTP 400`) to preserve 1:1 per-request authorization auditing.

## Environment Variables

| Variable                 | Default                     | Description                                                                |
| ------------------------ | --------------------------- | -------------------------------------------------------------------------- |
| `GATEWAY_HOST`           | `127.0.0.1`                 | Host interface for the security gateway                                    |
| `GATEWAY_PORT`           | `4010`                      | TCP port for the security gateway                                          |
| `DOWNSTREAM_HOST`        | `127.0.0.1`                 | Host interface for the downstream mock server                              |
| `DOWNSTREAM_PORT`        | `4011`                      | TCP port for the downstream mock server                                    |
| `DOWNSTREAM_MCP_URL`     | `http://127.0.0.1:4011/mcp` | Upstream target URL forwarded to by the gateway                            |
| `START_DOWNSTREAM_MOCK`  | `true`                      | Automatically start the local downstream mock server alongside the gateway |
| `GATEWAY_TIMEOUT_MS`     | `5000`                      | Upstream HTTP forwarding timeout in milliseconds                           |
| `GATEWAY_MAX_BODY_BYTES` | `65536`                     | Maximum allowed incoming JSON-RPC request body size in bytes               |
| `ADMIN_TOKEN`            | `admin-token`               | Local-only demonstration token mapped to `admin`                           |
| `VIEWER_TOKEN`           | `viewer-token`              | Local-only demonstration token mapped to `viewer`                          |

## Running & Testing

```bash
# Start both the Security Gateway (:4010) and Downstream Mock (:4011)
npm run dev:task2

# Run Task 2 unit and security integration tests
npm run test:task2
```

## Copy-Pasteable Verification Requests

### 1. Missing Token -> `HTTP 401`

**Bash:**

**Bash:**
```bash
curl -i -X POST http://127.0.0.1:4010/mcp \
  -H "Content-Type: application/json" \
  -d '{"jsonrpc":"2.0","id":1,"method":"tools/list"}'
```

**Windows PowerShell:**

```powershell
@'
{"jsonrpc":"2.0","id":1,"method":"tools/list"}
'@ | curl.exe -i -X POST http://127.0.0.1:4010/mcp -H "Content-Type: application/json" --data-binary "@-"
```

**Windows PowerShell:**
```powershell
@'
{"jsonrpc":"2.0","id":1,"method":"tools/list"}
'@ | curl.exe -i -X POST http://127.0.0.1:4010/mcp -H "Content-Type: application/json" --data-binary "@-"
```

### 2. Viewer Calling `tools/list` -> `HTTP 200` (Forwarded)

**Bash:**

**Bash:**
```bash
curl -s -X POST http://127.0.0.1:4010/mcp \
  -H "Content-Type: application/json" \
  -H "Authorization: Bearer viewer-token" \
  -d '{"jsonrpc":"2.0","id":"list-1","method":"tools/list"}'
```

**Windows PowerShell:**

```powershell
@'
{"jsonrpc":"2.0","id":"list-1","method":"tools/list"}
'@ | curl.exe -s -X POST http://127.0.0.1:4010/mcp -H "Content-Type: application/json" -H "Authorization: Bearer viewer-token" --data-binary "@-"
```

**Windows PowerShell:**
```powershell
@'
{"jsonrpc":"2.0","id":"list-1","method":"tools/list"}
'@ | curl.exe -s -X POST http://127.0.0.1:4010/mcp -H "Content-Type: application/json" -H "Authorization: Bearer viewer-token" --data-binary "@-"
```

### 3. Viewer Calling Normal Tool (`get_customer_record`) -> `HTTP 200` (Allowed)

**Bash:**

**Bash:**
```bash
curl -s -X POST http://127.0.0.1:4010/mcp \
  -H "Content-Type: application/json" \
  -H "Authorization: Bearer viewer-token" \
  -d '{"jsonrpc":"2.0","id":"call-normal","method":"tools/call","params":{"name":"get_customer_record","arguments":{"customer_id":"CUST-12345"}}}'
```

**Windows PowerShell:**

```powershell
@'
{"jsonrpc":"2.0","id":"call-normal","method":"tools/call","params":{"name":"get_customer_record","arguments":{"customer_id":"CUST-12345"}}}
'@ | curl.exe -s -X POST http://127.0.0.1:4010/mcp -H "Content-Type: application/json" -H "Authorization: Bearer viewer-token" --data-binary "@-"
```

**Windows PowerShell:**
```powershell
@'
{"jsonrpc":"2.0","id":"call-normal","method":"tools/call","params":{"name":"get_customer_record","arguments":{"customer_id":"CUST-12345"}}}
'@ | curl.exe -s -X POST http://127.0.0.1:4010/mcp -H "Content-Type: application/json" -H "Authorization: Bearer viewer-token" --data-binary "@-"
```

### 4. Viewer Calling `admin_reset_key` -> Intercepted (`-32001 Unauthorized Tool Call`)

**Bash:**

**Bash:**
```bash
curl -s -X POST http://127.0.0.1:4010/mcp \
  -H "Content-Type: application/json" \
  -H "Authorization: Bearer viewer-token" \
  -d '{"jsonrpc":"2.0","id":"call-blocked","method":"tools/call","params":{"name":"admin_reset_key","arguments":{"tenant_id":"acme"}}}'
```

**Windows PowerShell:**

```powershell
@'
{"jsonrpc":"2.0","id":"call-blocked","method":"tools/call","params":{"name":"admin_reset_key","arguments":{"tenant_id":"acme"}}}
'@ | curl.exe -s -X POST http://127.0.0.1:4010/mcp -H "Content-Type: application/json" -H "Authorization: Bearer viewer-token" --data-binary "@-"
```

**Windows PowerShell:**
```powershell
@'
{"jsonrpc":"2.0","id":"call-blocked","method":"tools/call","params":{"name":"admin_reset_key","arguments":{"tenant_id":"acme"}}}
'@ | curl.exe -s -X POST http://127.0.0.1:4010/mcp -H "Content-Type: application/json" -H "Authorization: Bearer viewer-token" --data-binary "@-"
```

Expected response:

```json
{
  "jsonrpc": "2.0",
  "id": "call-blocked",
  "error": { "code": -32001, "message": "Unauthorized Tool Call" }
}
```

### 5. Admin Calling `admin_reset_key` -> `HTTP 200` (Allowed)

**Bash:**

**Bash:**
```bash
curl -s -X POST http://127.0.0.1:4010/mcp \
  -H "Content-Type: application/json" \
  -H "Authorization: Bearer admin-token" \
  -d '{"jsonrpc":"2.0","id":"call-admin","method":"tools/call","params":{"name":"admin_reset_key","arguments":{"tenant_id":"acme"}}}'
```

**Windows PowerShell:**

```powershell
@'
{"jsonrpc":"2.0","id":"call-admin","method":"tools/call","params":{"name":"admin_reset_key","arguments":{"tenant_id":"acme"}}}
'@ | curl.exe -s -X POST http://127.0.0.1:4010/mcp -H "Content-Type: application/json" -H "Authorization: Bearer admin-token" --data-binary "@-"
```

**Windows PowerShell:**
```powershell
@'
{"jsonrpc":"2.0","id":"call-admin","method":"tools/call","params":{"name":"admin_reset_key","arguments":{"tenant_id":"acme"}}}
'@ | curl.exe -s -X POST http://127.0.0.1:4010/mcp -H "Content-Type: application/json" -H "Authorization: Bearer admin-token" --data-binary "@-"
```

### 6. Inspect Downstream Mock Invocation Counters

```bash
curl -s http://127.0.0.1:4011/health
```
