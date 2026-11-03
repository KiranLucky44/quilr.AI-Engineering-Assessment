# Task 3: LLM Streaming PII Redaction Gateway (`@quill-ai/task-3-llm-streaming-guardrail`)

An OpenAI-compatible HTTP Server-Sent Events (SSE) LLM gateway (`POST /v1/chat/completions` on port `4020`) that intercepts streaming completion deltas and redacts sensitive PII (`[REDACTED]`) in real time—even when sensitive tokens are split arbitrarily across chunk boundaries.

## Supported PII Categories & Bounded Memory Design

1. **Email Addresses** (max `254` chars per RFC 5321/5322)
2. **US Social Security Numbers** (max `11` chars: `DDD-DD-DDDD`, `DDD DD DDDD`, or `DDDDDDDDD`, validated against SSA area/group/serial rules)
3. **Credit / Debit Card Numbers** (max `23` chars: 13–19 digits with optional uniform spaces or hyphens, validated with ISO/IEC 7812 Luhn checksums)

### Stateful Bounded Look-Behind Redactor (`StreamingRedactor`)

- Never accumulates entire completions in memory: internal pending state is strictly bounded by `MAX_HOLD_BUFFER_LENGTH = 256` characters plus a `1`-character `lastInputChar` left-boundary tracker ($O(1)$ memory regardless of stream length).
- Emits provably safe prose immediately ($0\text{ ms}$ holdback when no candidate PII prefix is active at the chunk tail) while holding incomplete or right-boundary-ambiguous prefixes until sealed by a delimiter or finalized by `flush()` at stream end.
- Respects Node.js writable stream backpressure (`drain` event) and propagates client disconnects via `AbortController` to stop upstream generation immediately.

## Environment Variables

| Variable                   | Default     | Description                                                            |
| -------------------------- | ----------- | ---------------------------------------------------------------------- |
| `STREAMING_GATEWAY_HOST`   | `127.0.0.1` | Host interface to bind                                                 |
| `STREAMING_GATEWAY_PORT`   | `4020`      | TCP port for the streaming gateway                                     |
| `STREAMING_MAX_BODY_BYTES` | `131072`    | Maximum allowed JSON request payload size in bytes                     |
| `MOCK_CHUNK_DELAY_MS`      | `10`        | Simulated inter-chunk streaming delay (ms) for the local mock provider |

## Running & Testing

```bash
# Start the Streaming PII Redaction Gateway on http://127.0.0.1:4020
npm run dev:task3

# Run Task 3 unit, exhaustive split-boundary, and SSE integration tests
npm run test:task3
```

## Copy-Pasteable `curl` Streaming Requests

### 1. Default Synthetic Demo (Splits Email, SSN, and Card Across Chunk Boundaries)

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

Expected SSE stream (`text/event-stream`):

```text
data: {"id":"chatcmpl_mock_deterministic_01","object":"chat.completion.chunk","created":1769904000,"model":"quill-mock-gpt","system_fingerprint":"fp_quill_guardrail_v1","choices":[{"index":0,"delta":{"role":"assistant","content":""},"finish_reason":null}]}

data: {"id":"chatcmpl_mock_deterministic_01","object":"chat.completion.chunk","created":1769904000,"model":"quill-mock-gpt","system_fingerprint":"fp_quill_guardrail_v1","choices":[{"index":0,"delta":{"content":"Hello! For billing support, reach out to "},"finish_reason":null}]}

data: {"id":"chatcmpl_mock_deterministic_01","object":"chat.completion.chunk","created":1769904000,"model":"quill-mock-gpt","system_fingerprint":"fp_quill_guardrail_v1","choices":[{"index":0,"delta":{"content":"[REDACTED] regarding account SSN "},"finish_reason":null}]}

data: {"id":"chatcmpl_mock_deterministic_01","object":"chat.completion.chunk","created":1769904000,"model":"quill-mock-gpt","system_fingerprint":"fp_quill_guardrail_v1","choices":[{"index":0,"delta":{"content":"[REDACTED] and test payment card "},"finish_reason":null}]}

data: {"id":"chatcmpl_mock_deterministic_01","object":"chat.completion.chunk","created":1769904000,"model":"quill-mock-gpt","system_fingerprint":"fp_quill_guardrail_v1","choices":[{"index":0,"delta":{"content":"[REDACTED]. "},"finish_reason":null}]}

data: {"id":"chatcmpl_mock_deterministic_01","object":"chat.completion.chunk","created":1769904000,"model":"quill-mock-gpt","system_fingerprint":"fp_quill_guardrail_v1","choices":[{"index":0,"delta":{"content":"Have a wonderful day!"},"finish_reason":null}]}

data: {"id":"chatcmpl_mock_deterministic_01","object":"chat.completion.chunk","created":1769904000,"model":"quill-mock-gpt","system_fingerprint":"fp_quill_guardrail_v1","choices":[{"index":0,"delta":{},"finish_reason":"stop"}]}

data: [DONE]
```

### 2. Three-Chunk Split Email Scenario (`"Contact john@"` + `"gmail."` + `"com..."`)

```bash
curl -N -X POST http://127.0.0.1:4020/v1/chat/completions \
  -H "Content-Type: application/json" \
  -d '{
    "model": "quill-mock-gpt",
    "stream": true,
    "mock_scenario": "email_three_chunk",
    "messages": [
      { "role": "user", "content": "Test 3-chunk email split" }
    ]
  }'
```
