import { describe, expect, it } from 'vitest';
import {
  findPiiMatches,
  isValidUsSsnDigits,
  passesLuhnChecksum,
} from '../src/streaming/pii-patterns.js';

describe('PII Pattern Primitives (Task 3)', () => {
  it('validates Luhn checksums accurately and rejects repeated-digit sequences', () => {
    expect(passesLuhnChecksum('4111111111111111')).toBe(true);
    expect(passesLuhnChecksum('5555555555554444')).toBe(true);
    expect(passesLuhnChecksum('378282246310005')).toBe(true);
    expect(passesLuhnChecksum('6011111111111117')).toBe(true);

    expect(passesLuhnChecksum('4111111111111112')).toBe(false);
    expect(passesLuhnChecksum('0000000000000000')).toBe(false);
    expect(passesLuhnChecksum('123456789012')).toBe(false);
  });

  it('validates SSA structural rules for US Social Security Numbers', () => {
    expect(isValidUsSsnDigits('123456789')).toBe(true);
    expect(isValidUsSsnDigits('001010001')).toBe(true);

    expect(isValidUsSsnDigits('000456789')).toBe(false);
    expect(isValidUsSsnDigits('666456789')).toBe(false);
    expect(isValidUsSsnDigits('912456789')).toBe(false);
    expect(isValidUsSsnDigits('123006789')).toBe(false);
    expect(isValidUsSsnDigits('123450000')).toBe(false);
  });

  it('detects emails, SSNs, and credit cards without false positives on dates, order IDs, or timestamps', () => {
    const sample =
      'Order ORD-90112 created 2026-11-02 (ts 1735689600123) for CUST-12345: email jane.roe+billing@sub.example.co.uk, SSN 123-45-6789, card 4111-1111-1111-1111.';

    const matches = findPiiMatches(sample);
    expect(matches.map((m) => m.category)).toEqual(['EMAIL', 'SSN', 'CREDIT_CARD']);
    const [emailMatch, ssnMatch, cardMatch] = matches;
    expect(emailMatch && sample.slice(emailMatch.start, emailMatch.end)).toBe(
      'jane.roe+billing@sub.example.co.uk',
    );
    expect(ssnMatch && sample.slice(ssnMatch.start, ssnMatch.end)).toBe('123-45-6789');
    expect(cardMatch && sample.slice(cardMatch.start, cardMatch.end)).toBe('4111-1111-1111-1111');
  });
});
