# Task 1: Custom MCP Server (`@quill-ai/task-1-mcp-server`)

A Model Context Protocol (MCP) server built with the official **`@modelcontextprotocol/sdk` (`v1.32.2`)**, **`StdioServerTransport`**, and **strict Zod validation**.

## Exposed Tools

### 1. `get_customer_record`

Retrieves a deterministic synthetic customer account profile and recent order history.

- **Input Schema (`.strict()`)**:
  - `customer_id`: `string` matching `^CUST-[0-9]{5}$` (e.g., `"CUST-12345"`).
  - Additional properties are strictly rejected with JSON-RPC `-32602` (`Invalid Params`).
  - Seeded records include `CUST-12345`, `CUST-10001`, and `CUST-54321`; `CUST-00000` is reserved as a deterministic `"not found"` fixture; all other valid `CUST-XXXXX` IDs resolve deterministically.

### 2. `trigger_refund`

Executes a **simulated** deterministic refund calculation without ever connecting to real payment rails.

- **Input Schema (`.strict()`)**:
  - `customer_id`: `string` matching `^CUST-[0-9]{5}$`.
  - `amount`: finite positive `number` (`> 0`, rejects `0`, negatives, `NaN`, `Infinity`).
  - `reason`: `string` with `reason.trim().length >= 10`.
  - Additional properties are strictly rejected with JSON-RPC `-32602`.

## Stdio Protocol Isolation

`stdout` is reserved exclusively for newline-delimited MCP JSON-RPC 2.0 frames. All diagnostic, startup, and warning logs are written as structured JSON to `process.stderr` via `createStderrLogger` (`src/config/logger.ts`), enforced statically by ESLint (`no-console: error`).

## Environment Variables

| Variable               | Default | Description                                                                     |
| ---------------------- | ------- | ------------------------------------------------------------------------------- |
| `MCP_SERVER_LOG_LEVEL` | `info`  | Log verbosity emitted to `stderr` (`debug`, `info`, `warn`, `error`, `silent`). |

## Running & Testing Independently

From the repository root:

```bash
# Start MCP server over stdio (development mode)
npm run dev:task1

# Build and start compiled JS
npm run build
npm start --workspace=@quill-ai/task-1-mcp-server

# Run Task 1 unit & real stdio client integration tests
npm run test:task1
```

## Example Raw Stdio JSON-RPC Session

You can pipe MCP JSON-RPC messages directly over `stdin` to observe pure JSON-RPC `stdout` responses:

**Bash:**

**Bash:**
```bash
printf '%s\n' \
  '{"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":"2024-11-05","capabilities":{},"clientInfo":{"name":"manual-cli","version":"1.0.0"}}}' \
  '{"jsonrpc":"2.0","method":"notifications/initialized"}' \
  '{"jsonrpc":"2.0","id":2,"method":"tools/list","params":{}}' \
  '{"jsonrpc":"2.0","id":3,"method":"tools/call","params":{"name":"trigger_refund","arguments":{"customer_id":"CUST-12345","amount":150.50,"reason":"Duplicate payment"}}}' \
  | npm run --silent dev:task1
```

**Windows PowerShell:**

```powershell
@'
{"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":"2024-11-05","capabilities":{},"clientInfo":{"name":"manual-cli","version":"1.0.0"}}}
{"jsonrpc":"2.0","method":"notifications/initialized"}
{"jsonrpc":"2.0","id":2,"method":"tools/list","params":{}}
{"jsonrpc":"2.0","id":3,"method":"tools/call","params":{"name":"trigger_refund","arguments":{"customer_id":"CUST-12345","amount":150.50,"reason":"Duplicate payment"}}}
'@ | npm run --silent dev:task1
```

**Windows PowerShell:**
```powershell
@'
{"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":"2024-11-05","capabilities":{},"clientInfo":{"name":"manual-cli","version":"1.0.0"}}}
{"jsonrpc":"2.0","method":"notifications/initialized"}
{"jsonrpc":"2.0","id":2,"method":"tools/list","params":{}}
{"jsonrpc":"2.0","id":3,"method":"tools/call","params":{"name":"trigger_refund","arguments":{"customer_id":"CUST-12345","amount":150.50,"reason":"Duplicate payment"}}}
'@ | npm run --silent dev:task1
```

### Expected Tool Call Response (`id: 3`)

```json
{
  "result": {
    "content": [
      {
        "type": "text",
        "text": "{\"simulated\":true,\"status\":\"APPROVED\",\"refund_id\":\"REF-89D03AEF4B\",\"customer_id\":\"CUST-12345\",\"amount_usd\":150.5,\"currency\":\"USD\",\"reason\":\"Duplicate payment\",\"processed_at\":\"2026-02-01T00:00:00.000Z\",\"message\":\"Simulated refund REF-89D03AEF4B for $150.50 USD approved for Elena Vance (CUST-12345).\"}"
      }
    ]
  },
  "jsonrpc": "2.0",
  "id": 3
}
```

### Expected Invalid Input Error Response (`-32602`)

Input:

```json
{
  "jsonrpc": "2.0",
  "id": 4,
  "method": "tools/call",
  "params": {
    "name": "trigger_refund",
    "arguments": { "customer_id": "CUST-12345", "amount": -10, "reason": "short" }
  }
}
```

Response:

```json
{
  "jsonrpc": "2.0",
  "id": 4,
  "error": {
    "code": -32602,
    "message": "MCP error -32602: Invalid arguments for tool \"trigger_refund\": amount: amount must be strictly greater than zero; reason: reason must contain at least 10 characters after trimming"
  }
}
```

## Optional Inspection with MCP Inspector

### Web UI Mode

```bash
npm run build --workspace=@quill-ai/task-1-mcp-server
npx @modelcontextprotocol/inspector node packages/task-1-mcp-server/dist/index.js
```

> **Important MCP Inspector Web UI Input Tip**:
>
> - In **Form Mode**, enter the raw field value `CUST-12345` (without surrounding quotes or braces) into the `customer_id` field, and click **Execute Tool** directly (pressing `Enter` inside a string field in MCP Inspector v2.x inserts a `\n` newline character into the string, which strict `^CUST-[0-9]{5}$` validation rightly rejects with `-32602`).
> - To paste full JSON payloads like `{"customer_id":"CUST-12345"}` or `{"customer_id":"CUST-12345","amount":150.50,"reason":"Duplicate payment"}`, switch the Arguments input from **Form** to **JSON** mode first.

### CLI Mode

```bash
npx @modelcontextprotocol/inspector --cli --method tools/call --tool-name get_customer_record --tool-arg customer_id=CUST-12345 -- node packages/task-1-mcp-server/dist/index.js

npx @modelcontextprotocol/inspector --cli --method tools/call --tool-name trigger_refund --tool-arg customer_id=CUST-12345 amount=150.50 "reason=Duplicate payment" -- node packages/task-1-mcp-server/dist/index.js
```
