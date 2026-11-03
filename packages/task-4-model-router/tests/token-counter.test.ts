import { describe, expect, it } from 'vitest';
import { TiktokenTokenCounter } from '../src/limiter/token-counter.js';

describe('TiktokenTokenCounter (Task 4)', () => {
  const counter = new TiktokenTokenCounter();

  it('counts BPE tokens deterministically and reserves prompt + max_tokens', () => {
    const messages = [
      { role: 'system' as const, content: 'You are a concise assistant.' },
      { role: 'user' as const, content: 'Summarize quarterly cloud infrastructure spend.' },
    ];

    const est = counter.estimateReservation(messages, 200, 256);
    expect(est.promptTokens).toBeGreaterThan(10);
    expect(est.completionBudget).toBe(200);
    expect(est.reservedTokens).toBe(est.promptTokens + 200);
  });

  it('falls back to configured defaultMaxTokens when caller omits max_tokens', () => {
    const est = counter.estimateReservation(
      [{ role: 'user', content: 'Hello router!' }],
      undefined,
      512,
    );
    expect(est.completionBudget).toBe(512);
    expect(est.reservedTokens).toBe(est.promptTokens + 512);
  });

  it('reconciles actual tokens using authoritative provider usage or conservative BPE fallback', () => {
    expect(
      counter.reconcileActualTokens(25, 'Short answer.', {
        promptTokens: 25,
        completionTokens: 4,
        totalTokens: 29,
      }),
    ).toBe(29);

    const fallbackTotal = counter.reconcileActualTokens(
      25,
      'Provider omitted usage metadata so router counts completion tokens locally.',
      undefined,
    );
    expect(fallbackTotal).toBeGreaterThan(25);
  });
});
