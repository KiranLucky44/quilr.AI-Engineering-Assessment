# Task 3: LLM Streaming PII Redaction Gateway (`@quill-ai/task-3-llm-streaming-guardrail`)

An OpenAI-compatible HTTP Server-Sent Events (SSE) LLM gateway (`POST /v1/chat/completions` on port `4020`) that intercepts streaming completion deltas and redacts sensitive PII (`[REDACTED]`) in real time—even when sensitive tokens are split arbitrarily across chunk boundaries.

Supports two upstream provider modes out of the box:

1. **Deterministic Mock Mode (`LLM_PROVIDER=mock`, default)** — Zero external dependencies or API credentials; ideal for automated CI and deterministic split-boundary verification.
2. **Real Local Ollama Mode (`LLM_PROVIDER=ollama`)** — Streams live completions from Ollama's OpenAI-compatible `POST /v1/chat/completions` endpoint (`http://127.0.0.1:11434/v1` by default, model `llama3.2:1b`) and pipes every upstream token delta through the stateful `StreamingRedactor` before emitting SSE frames.

## Supported PII Categories & Bounded Memory Design

1. **Email Addresses** (max `254` chars per RFC 5321/5322)
2. **US Social Security Numbers** (max `11` chars: `DDD-DD-DDDD`, `DDD DD DDDD`, or `DDDDDDDDD`, validated against SSA area/group/serial rules)
3. **Credit / Debit Card Numbers** (max `23` chars: 13–19 digits with optional uniform spaces or hyphens, validated with ISO/IEC 7812 Luhn checksums)

### Stateful Bounded Look-Behind Redactor (`StreamingRedactor`)

- Never accumulates entire completions in memory: internal pending state is strictly bounded by `MAX_HOLD_BUFFER_LENGTH = 256` characters plus a `1`-character `lastInputChar` left-boundary tracker ($O(1)$ memory regardless of stream length).
- Emits provably safe prose immediately ($0\text{ ms}$ holdback when no candidate PII prefix is active at the chunk tail) while holding incomplete or right-boundary-ambiguous prefixes until sealed by a delimiter or finalized by `flush()` at stream end.
- Respects Node.js writable stream backpressure (`drain` event) and propagates client disconnects via `AbortController` to abort upstream generation immediately.

## Installing Ollama & Pulling the Local Model (Optional)

Automated tests run in `mock` mode by default and **do not** require Ollama. To run against a genuine local LLM without paid API keys:

```bash
# Windows (winget)
winget install Ollama.Ollama

# macOS (Homebrew)
brew install ollama

# Linux
curl -fsSL https://ollama.com/install.sh | sh
```

Start Ollama and pull the lightweight `llama3.2:1b` model (or use any installed local model):

```bash
ollama serve
ollama pull llama3.2:1b
```

## Environment Variables

Task 3 automatically loads the repository root `.env` file on startup (without overriding explicit shell environment variables).

| Variable                   | Default                     | Description                                                              |
| -------------------------- | --------------------------- | ------------------------------------------------------------------------ |
| `LLM_PROVIDER`             | `mock`                      | Upstream provider selector: `mock` (default) or `ollama`                 |
| `OLLAMA_BASE_URL`          | `http://127.0.0.1:11434/v1` | OpenAI-compatible base URL for Ollama                                    |
| `OLLAMA_MODEL`             | `llama3.2:1b`               | Default Ollama model identifier                                          |
| `OLLAMA_TIMEOUT_MS`        | `30000`                     | Upstream connection and per-chunk idle stall timeout in milliseconds     |
| `OLLAMA_API_KEY`           | _(unset)_                   | Optional Bearer token if Ollama is behind an authenticated reverse proxy |
| `STREAMING_GATEWAY_HOST`   | `127.0.0.1`                 | Host interface to bind                                                   |
| `STREAMING_GATEWAY_PORT`   | `4020`                      | TCP port for the streaming gateway                                       |
| `STREAMING_MAX_BODY_BYTES` | `131072`                    | Maximum allowed JSON request payload size in bytes                       |
| `MOCK_CHUNK_DELAY_MS`      | `10`                        | Simulated inter-chunk streaming delay (ms) for `MockLLMProvider`         |

To switch to real Ollama mode via `.env`, set:

```dotenv
LLM_PROVIDER=ollama
OLLAMA_BASE_URL=http://127.0.0.1:11434/v1
OLLAMA_MODEL=llama3.2:1b
```

## Running & Testing

### 1. Run Automated Tests Without Ollama (Default Mock + Local HTTP Test Servers)

```bash
npm run test:task3
```

### 2. Run Opt-In Live Integration Tests Against Local Ollama

Ensure `ollama serve` is running and the target model is pulled:

```bash
# Bash
OLLAMA_LIVE_TEST=true OLLAMA_MODEL=llama3.2:1b npm run test:task3
```

```powershell
# Windows PowerShell
$env:OLLAMA_LIVE_TEST="true"; $env:OLLAMA_MODEL="llama3.2:1b"; npm run test:task3; Remove-Item Env:OLLAMA_LIVE_TEST
```

### 3. Start the Gateway Server

```bash
# Starts on http://127.0.0.1:4020 using LLM_PROVIDER from .env (defaults to mock)
npm run dev:task3
```

## API Request Examples

> **Windows PowerShell Note**: Windows PowerShell 5.1 strips unescaped `"` inside `curl.exe -d '{ "model": ... }'`, sending invalid JSON. On Windows PowerShell, pipe a single-quoted here-string (`@'...'@`) to `curl.exe --data-binary "@-"` as shown below.

### Example A: Mock Mode — Synthetic Split-PII Demo (`LLM_PROVIDER=mock`)

**Bash / macOS / Linux / Git Bash:**

```bash
curl -N -X POST http://127.0.0.1:4020/v1/chat/completions \
  -H "Content-Type: application/json" \
  -d '{
    "model": "quill-mock-gpt",
    "stream": true,
    "messages": [
      { "role": "user", "content": "Show synthetic billing summary" }
    ]
  }'
```

**Windows PowerShell:**

```powershell
@'
{
  "model": "quill-mock-gpt",
  "stream": true,
  "messages": [
    { "role": "user", "content": "Show synthetic billing summary" }
  ]
}
'@ | curl.exe -N -X POST http://127.0.0.1:4020/v1/chat/completions -H "Content-Type: application/json" --data-binary "@-"
```

### Example B: Real Ollama Mode — Live Streaming PII Redaction (`LLM_PROVIDER=ollama`)

**Bash / macOS / Linux / Git Bash:**

```bash
curl -N -X POST http://127.0.0.1:4020/v1/chat/completions \
  -H "Content-Type: application/json" \
  -d '{
    "model": "llama3.2:1b",
    "stream": true,
    "temperature": 0,
    "messages": [
      {
        "role": "user",
        "content": "Repeat this exact line: Customer email is john.doe@example.com, SSN is 123-45-6789, and test Visa is 4111-1111-1111-1111."
      }
    ]
  }'
```

**Windows PowerShell:**

```powershell
@'
{
  "model": "llama3.2:1b",
  "stream": true,
  "temperature": 0,
  "messages": [
    {
      "role": "user",
      "content": "Repeat this exact line: Customer email is john.doe@example.com, SSN is 123-45-6789, and test Visa is 4111-1111-1111-1111."
    }
  ]
}
'@ | curl.exe -N -X POST http://127.0.0.1:4020/v1/chat/completions -H "Content-Type: application/json" --data-binary "@-"
```

Every sensitive token emitted by Ollama is redacted in flight (`[REDACTED]`) before reaching the HTTP response stream, ending with `data: [DONE]`.
