import { z } from 'zod';
import type { ChatCompletionStreamRequest } from '../providers/llm-provider.interface.js';

const ChatMessageSchema = z
  .object({
    role: z.enum(['system', 'user', 'assistant']),
    content: z.string().min(1, 'message content must be a non-empty string'),
  })
  .strict();

const MockScenarioSchema = z.enum([
  'default_demo',
  'email_three_chunk',
  'ssn_split',
  'card_split',
  'long_stream',
  'upstream_midstream_error',
]);

export const ChatCompletionStreamRequestSchema = z
  .object({
    model: z.string().trim().min(1, 'model must be a non-empty string'),
    messages: z.array(ChatMessageSchema).min(1, 'messages must contain at least one message'),
    stream: z.literal(true, {
      errorMap: () => ({
        message: 'stream must be set to true for the streaming PII redaction gateway',
      }),
    }),
    temperature: z.number().finite().min(0).max(2).optional(),
    max_tokens: z.number().int().positive().max(32768).optional(),
    mock_scenario: MockScenarioSchema.optional(),
  })
  .strict();

export type RequestValidationErrorCode = 'MALFORMED_JSON' | 'VALIDATION_ERROR';

export type RequestValidationOutcome =
  | {
      readonly valid: true;
      readonly data: ChatCompletionStreamRequest;
    }
  | {
      readonly valid: false;
      readonly errorCode: RequestValidationErrorCode;
      readonly message: string;
    };

export function validateChatCompletionRequest(rawBody: string): RequestValidationOutcome {
  const normalizedBody = rawBody.startsWith('\uFEFF') ? rawBody.slice(1) : rawBody;

  if (normalizedBody.trim().length === 0) {
    return {
      valid: false,
      errorCode: 'MALFORMED_JSON',
      message: 'Malformed JSON request body: request body must not be empty.',
    };
  }

  let parsedJson: unknown;
  try {
    parsedJson = JSON.parse(normalizedBody);
  } catch {
    return {
      valid: false,
      errorCode: 'MALFORMED_JSON',
      message: 'Malformed JSON request body.',
    };
  }

  const parsed = ChatCompletionStreamRequestSchema.safeParse(parsedJson);
  if (!parsed.success) {
    const details = parsed.error.issues
      .map((issue) => {
        const path = issue.path.length > 0 ? issue.path.join('.') : 'body';
        return `${path}: ${issue.message}`;
      })
      .join('; ');
    return {
      valid: false,
      errorCode: 'VALIDATION_ERROR',
      message: `Invalid chat completion request: ${details}`,
    };
  }

  const validated: ChatCompletionStreamRequest = {
    model: parsed.data.model,
    messages: parsed.data.messages,
    stream: true,
    ...(parsed.data.temperature !== undefined ? { temperature: parsed.data.temperature } : {}),
    ...(parsed.data.max_tokens !== undefined ? { max_tokens: parsed.data.max_tokens } : {}),
    ...(parsed.data.mock_scenario !== undefined
      ? { mock_scenario: parsed.data.mock_scenario }
      : {}),
  };

  return {
    valid: true,
    data: validated,
  };
}
