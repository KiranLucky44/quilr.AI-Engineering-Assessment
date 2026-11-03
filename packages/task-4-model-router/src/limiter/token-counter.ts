import { getEncoding, type Tiktoken } from 'js-tiktoken';
import type {
  ProviderTokenUsage,
  RouterChatMessage,
} from '../providers/model-provider.interface.js';

export interface TokenReservationEstimate {
  readonly promptTokens: number;
  readonly completionBudget: number;
  readonly reservedTokens: number;
}

export interface TokenCounter {
  countText(text: string): number;
  countMessages(messages: readonly RouterChatMessage[]): number;
  estimateReservation(
    messages: readonly RouterChatMessage[],
    requestedMaxTokens: number | undefined,
    defaultMaxTokens: number,
  ): TokenReservationEstimate;
  reconcileActualTokens(
    promptTokens: number,
    completionText: string,
    providerUsage?: ProviderTokenUsage,
  ): number;
}

const TOKENS_PER_MESSAGE_FRAMING = 3;
const TOKENS_ASSISTANT_PRIMING = 3;

/**
 * Authoritative server-side BPE token counter using `js-tiktoken` (`cl100k_base`).
 * Never trusts client-reported token counts.
 */
export class TiktokenTokenCounter implements TokenCounter {
  private readonly encoding: Tiktoken;

  public constructor() {
    this.encoding = getEncoding('cl100k_base');
  }

  public countText(text: string): number {
    if (text.length === 0) {
      return 0;
    }
    return this.encoding.encode(text).length;
  }

  public countMessages(messages: readonly RouterChatMessage[]): number {
    let total = TOKENS_ASSISTANT_PRIMING;
    for (const msg of messages) {
      total += TOKENS_PER_MESSAGE_FRAMING;
      total += this.countText(msg.role);
      total += this.countText(msg.content);
    }
    return Math.max(1, total);
  }

  public estimateReservation(
    messages: readonly RouterChatMessage[],
    requestedMaxTokens: number | undefined,
    defaultMaxTokens: number,
  ): TokenReservationEstimate {
    const promptTokens = this.countMessages(messages);
    const completionBudget = Math.max(1, requestedMaxTokens ?? defaultMaxTokens);
    return {
      promptTokens,
      completionBudget,
      reservedTokens: promptTokens + completionBudget,
    };
  }

  /**
   * Reconciles a token reservation after upstream model completion:
   * - Uses authoritative provider `usage.totalTokens` when valid and positive.
   * - Otherwise computes a conservative server-side BPE fallback:
   *   `promptTokens + max(1, countText(completionText))`.
   */
  public reconcileActualTokens(
    promptTokens: number,
    completionText: string,
    providerUsage?: ProviderTokenUsage,
  ): number {
    if (
      providerUsage &&
      Number.isSafeInteger(providerUsage.totalTokens) &&
      providerUsage.totalTokens > 0
    ) {
      return providerUsage.totalTokens;
    }

    const estimatedOutputTokens = Math.max(1, this.countText(completionText));
    return promptTokens + estimatedOutputTokens;
  }
}
