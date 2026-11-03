export type ChatRole = 'system' | 'user' | 'assistant';

export interface ChatMessage {
  readonly role: ChatRole;
  readonly content: string;
}

export type MockScenarioName =
  | 'default_demo'
  | 'email_three_chunk'
  | 'ssn_split'
  | 'card_split'
  | 'long_stream'
  | 'upstream_midstream_error';

export interface ChatCompletionStreamRequest {
  readonly model: string;
  readonly messages: readonly ChatMessage[];
  readonly stream: true;
  readonly temperature?: number;
  readonly max_tokens?: number;
  readonly mock_scenario?: MockScenarioName;
}

export interface NormalizedCompletionDelta {
  readonly id: string;
  readonly created: number;
  readonly model: string;
  readonly systemFingerprint?: string;
  readonly role?: 'assistant';
  readonly contentDelta?: string;
  readonly finishReason?: 'stop' | 'length' | null;
}

export interface LLMStreamProvider {
  readonly providerName: string;
  streamChatCompletion(
    request: ChatCompletionStreamRequest,
    signal: AbortSignal,
  ): AsyncIterable<NormalizedCompletionDelta>;
}
