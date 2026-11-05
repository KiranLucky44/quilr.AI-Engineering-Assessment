import { describe, expect, it } from 'vitest';
import { MAX_HOLD_BUFFER_LENGTH } from '../src/streaming/pii-patterns.js';
import { StreamingRedactor } from '../src/streaming/streaming-redactor.js';

function runChunks(chunks: readonly string[]): {
  output: string;
  intermediateOutputs: string[];
  peakBufferedChars: number;
  redactionCount: number;
} {
  const redactor = new StreamingRedactor();
  const intermediateOutputs: string[] = [];

  for (const chunk of chunks) {
    const emitted = redactor.push(chunk);
    intermediateOutputs.push(emitted);
  }
  const finalTail = redactor.flush();
  intermediateOutputs.push(finalTail);

  const stats = redactor.getStats();
  return {
    output: intermediateOutputs.join(''),
    intermediateOutputs,
    peakBufferedChars: stats.peakBufferedChars,
    redactionCount: stats.redactionCount,
  };
}

describe('StreamingRedactor Core Semantics & Bounded Buffering (Task 3)', () => {
  it('redacts complete email, SSN, and credit card in single chunks', () => {
    expect(runChunks(['Contact john@gmail.com today.']).output).toBe('Contact [REDACTED] today.');
    expect(runChunks(['Taxpayer SSN: 123-45-6789.']).output).toBe('Taxpayer SSN: [REDACTED].');
    expect(runChunks(['Card on file: 4111111111111111.']).output).toBe('Card on file: [REDACTED].');
  });

  it('redacts multiple PII patterns in a single response', () => {
    const res = runChunks([
      'Contact john@gmail.com regarding card 4111111111111111 and SSN 123-45-6789.',
    ]);
    expect(res.output).toBe('Contact [REDACTED] regarding card [REDACTED] and SSN [REDACTED].');
    expect(res.redactionCount).toBe(3);
  });

  it('emits provably safe text immediately before an incomplete PII pattern finishes', () => {
    const redactor = new StreamingRedactor();
    const firstEmit = redactor.push('Contact john@');
    expect(firstEmit).toBe('Contact ');

    const secondEmit = redactor.push('gmail.');
    expect(secondEmit).toBe('');

    const thirdEmit = redactor.push('com regarding the request.');
    const finalEmit = redactor.flush();

    expect(firstEmit + secondEmit + thirdEmit + finalEmit).toBe(
      'Contact [REDACTED] regarding the request.',
    );
  });

  it('handles PII beginning right near MAX_HOLD_BUFFER_LENGTH boundary and ending at final stream boundary', () => {
    const prefix = 'A '.repeat(MAX_HOLD_BUFFER_LENGTH); // 512 chars ending with space
    const res = runChunks([
      prefix.slice(0, MAX_HOLD_BUFFER_LENGTH - 3),
      `${prefix.slice(MAX_HOLD_BUFFER_LENGTH - 3)}john.smith@`,
      'enterprise-domain.com',
    ]);

    expect(res.output).toBe(`${prefix}[REDACTED]`);
    expect(res.output).not.toContain('john.smith');
    expect(res.output).not.toContain('enterprise-domain.com');
  });

  it('handles empty chunks cleanly without altering state', () => {
    const res = runChunks(['', 'Reach ', '', 'john@', '', 'gmail.', '', 'com', '']);
    expect(res.output).toBe('Reach [REDACTED]');
  });

  it('safely flushes both complete terminal PII and benign incomplete prefixes at stream end', () => {
    // Complete PII right at EOF without trailing punctuation must be redacted on flush()
    const eofEmail = new StreamingRedactor();
    expect(eofEmail.push('Email: john@gmail.com')).toBe('Email: ');
    expect(eofEmail.flush()).toBe('[REDACTED]');
    expect(eofEmail.getStats().bufferedChars).toBe(0);

    // Incomplete non-PII prefixes held at EOF must be flushed verbatim without data loss
    const benignEmailPrefix = new StreamingRedactor();
    expect(benignEmailPrefix.push('Incomplete handle john@')).toBe('Incomplete handle ');
    expect(benignEmailPrefix.flush()).toBe('john@');
    expect(benignEmailPrefix.getStats().bufferedChars).toBe(0);

    const benignNumericPrefix = new StreamingRedactor();
    expect(benignNumericPrefix.push('Partial reference 123-45')).toBe('Partial reference ');
    expect(benignNumericPrefix.flush()).toBe('123-45');
    expect(benignNumericPrefix.getStats().bufferedChars).toBe(0);
  });

  it('maintains O(1) bounded memory across a long 250,000+ character stream', () => {
    const redactor = new StreamingRedactor();
    let totalLength = 0;

    for (let i = 0; i < 2500; i += 1) {
      const segment =
        i % 500 === 250
          ? ' Alert user.audit@example.org with SSN 123-45-6789 and card 4111-1111-1111-1111 now. '
          : 'Routine streaming prose segment with zero sensitive tokens to verify bounded memory growth. ';
      const emitted = redactor.push(segment);
      totalLength += emitted.length;
      expect(emitted).not.toContain('user.audit@example.org');
      expect(emitted).not.toContain('123-45-6789');
      expect(emitted).not.toContain('4111-1111-1111-1111');
      expect(redactor.getStats().bufferedChars).toBeLessThanOrEqual(MAX_HOLD_BUFFER_LENGTH);
    }

    totalLength += redactor.flush().length;
    const stats = redactor.getStats();

    expect(totalLength).toBeGreaterThan(200_000);
    expect(stats.peakBufferedChars).toBeLessThanOrEqual(MAX_HOLD_BUFFER_LENGTH);
    expect(stats.redactionCount).toBe(15);
  });
});
