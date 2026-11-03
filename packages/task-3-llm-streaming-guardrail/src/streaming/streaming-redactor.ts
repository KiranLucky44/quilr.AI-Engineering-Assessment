import {
  canCompleteMatchStillExtend,
  findPiiMatches,
  isViableEmailPrefix,
  isViableNumericPiiPrefix,
  MAX_HOLD_BUFFER_LENGTH,
  REDACTION_TOKEN,
} from './pii-patterns.js';

export interface StreamingRedactorStats {
  readonly bufferedChars: number;
  readonly peakBufferedChars: number;
  readonly redactionCount: number;
}

/**
 * Stateful, bounded-memory incremental streaming PII redactor.
 *
 * Guarantees:
 * 1. Never emits a partial Email, US SSN, or Credit/Debit Card before confirming it is safe.
 * 2. Detects PII split across arbitrary chunk boundaries (including 1-character chunks).
 * 3. Emits provably safe prefix characters immediately to minimize time-to-first-token latency.
 * 4. Bounds internal pending buffer memory to `MAX_HOLD_BUFFER_LENGTH` (256 chars), O(1) with
 *    respect to total stream length.
 */
export class StreamingRedactor {
  private pendingBuffer = '';
  private lastInputChar = '';
  private peakBufferedChars = 0;
  private redactionCount = 0;
  private readonly replacement: string;

  public constructor(replacement: string = REDACTION_TOKEN) {
    this.replacement = replacement;
  }

  /**
   * Feeds a new text delta into the streaming redactor and returns the prefix substring
   * that is provably safe (with any confirmed PII already replaced by `[REDACTED]`).
   */
  public push(chunk: string): string {
    if (chunk.length === 0) {
      return '';
    }

    let emitted = '';
    for (let offset = 0; offset < chunk.length; offset += MAX_HOLD_BUFFER_LENGTH) {
      this.pendingBuffer += chunk.slice(offset, offset + MAX_HOLD_BUFFER_LENGTH);
      emitted += this.drainSafeOutput(false);
    }
    return emitted;
  }

  /**
   * Finalizes the stream, redacting any complete PII remaining in the tail buffer,
   * flushing all remaining characters, and resetting internal state.
   */
  public flush(): string {
    const finalOutput = this.drainSafeOutput(true);
    this.pendingBuffer = '';
    this.lastInputChar = '';
    return finalOutput;
  }

  public getStats(): StreamingRedactorStats {
    return {
      bufferedChars: this.pendingBuffer.length,
      peakBufferedChars: this.peakBufferedChars,
      redactionCount: this.redactionCount,
    };
  }

  private drainSafeOutput(isFinal: boolean): string {
    if (this.pendingBuffer.length === 0) {
      return '';
    }

    const matches = findPiiMatches(this.pendingBuffer, this.lastInputChar);
    let output = '';
    let cursor = 0;
    let unsealedMatchStart: number | null = null;

    for (const match of matches) {
      if (!isFinal && canCompleteMatchStillExtend(this.pendingBuffer, match)) {
        unsealedMatchStart = match.start;
        break;
      }

      if (match.start > cursor) {
        output += this.pendingBuffer.slice(cursor, match.start);
      }
      output += this.replacement;
      this.redactionCount += 1;
      cursor = match.end;
    }

    if (cursor > 0) {
      this.lastInputChar = this.pendingBuffer[cursor - 1] ?? '';
      this.pendingBuffer = this.pendingBuffer.slice(cursor);
      if (unsealedMatchStart !== null) {
        unsealedMatchStart -= cursor;
      }
    }

    if (isFinal) {
      output += this.pendingBuffer;
      if (this.pendingBuffer.length > 0) {
        this.lastInputChar = this.pendingBuffer[this.pendingBuffer.length - 1] ?? '';
      }
      this.pendingBuffer = '';
      return output;
    }

    const holdIndex = this.computeEarliestHoldIndex(unsealedMatchStart);
    if (holdIndex > 0) {
      output += this.pendingBuffer.slice(0, holdIndex);
      this.lastInputChar = this.pendingBuffer[holdIndex - 1] ?? '';
      this.pendingBuffer = this.pendingBuffer.slice(holdIndex);
    }

    if (this.pendingBuffer.length > this.peakBufferedChars) {
      this.peakBufferedChars = this.pendingBuffer.length;
    }

    return output;
  }

  private computeEarliestHoldIndex(unsealedMatchStart: number | null): number {
    const len = this.pendingBuffer.length;
    if (len === 0) {
      return 0;
    }

    const minAllowedHoldIndex = Math.max(0, len - MAX_HOLD_BUFFER_LENGTH);
    const searchLimit = unsealedMatchStart !== null ? unsealedMatchStart : len;

    for (let idx = minAllowedHoldIndex; idx < searchLimit; idx += 1) {
      const leftChar = idx === 0 ? this.lastInputChar : (this.pendingBuffer[idx - 1] ?? '');
      const suffix = this.pendingBuffer.slice(idx);

      if (isViableEmailPrefix(suffix, leftChar) || isViableNumericPiiPrefix(suffix, leftChar)) {
        return idx;
      }
    }

    if (unsealedMatchStart !== null) {
      return Math.max(minAllowedHoldIndex, unsealedMatchStart);
    }

    return len;
  }
}
