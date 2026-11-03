import type { DemoScenario } from '../config.js';

export type RouterChatRole = 'system' | 'user' | 'assistant';

export interface RouterChatMessage {
  readonly role: RouterChatRole;
  readonly content: string;
}

export interface ModelCompletionRequest {
  readonly requestId: string;
  readonly model: string;
  readonly messages: readonly RouterChatMessage[];
  readonly maxTokens: number;
  readonly temperature?: number;
  readonly scenario?: DemoScenario;
}

export interface ProviderTokenUsage {
  readonly promptTokens: number;
  readonly completionTokens: number;
  readonly totalTokens: number;
}

export interface ModelCompletionResult {
  readonly id: string;
  readonly providerName: string;
  readonly model: string;
  readonly created: number;
  readonly content: string;
  readonly finishReason: 'stop' | 'length';
  readonly usage?: ProviderTokenUsage;
}

export interface ModelProvider {
  readonly providerName: string;
  generateCompletion(
    request: ModelCompletionRequest,
    signal: AbortSignal,
  ): Promise<ModelCompletionResult>;
}
