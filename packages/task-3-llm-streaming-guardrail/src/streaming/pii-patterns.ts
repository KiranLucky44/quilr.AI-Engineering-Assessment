export type PiiCategory = 'EMAIL' | 'SSN' | 'CREDIT_CARD';

export interface PiiMatch {
  readonly category: PiiCategory;
  readonly start: number;
  readonly end: number;
}

export const REDACTION_TOKEN = '[REDACTED]';

/**
 * Explicit upper bounds for supported PII patterns:
 * - RFC 5321/5322 practical maximum email address length: 254 characters (64 local + '@' + 189 domain).
 * - Payment card numbers (ISO/IEC 7812): 13-19 digits plus up to 4 single spaces or hyphens = 23 characters.
 * - US Social Security Numbers: 9 digits plus up to 2 spaces or hyphens = 11 characters.
 * - Lookahead safety margin: 2 characters to confirm trailing delimiters across chunk boundaries.
 */
export const MAX_EMAIL_LENGTH = 254;
export const MAX_EMAIL_LOCAL_LENGTH = 64;
export const MAX_CARD_LENGTH = 23;
export const MAX_SSN_LENGTH = 11;
export const MAX_HOLD_BUFFER_LENGTH = 256;

const EMAIL_LOCAL_CHAR_REGEX = /[A-Za-z0-9._%+-]/;
const NUMERIC_LEFT_DISALLOWED_REGEX = /[A-Za-z0-9-]/;
const NUMERIC_RIGHT_DISALLOWED_REGEX = /[A-Za-z0-9]/;

const COMPLETE_EMAIL_AT_START_REGEX =
  /^[A-Za-z0-9](?:[A-Za-z0-9._%+-]{0,62}[A-Za-z0-9_%+-])?@[A-Za-z0-9](?:[A-Za-z0-9-]{0,61}[A-Za-z0-9])?(?:\.[A-Za-z0-9](?:[A-Za-z0-9-]{0,61}[A-Za-z0-9])?)*\.[A-Za-z]{2,24}/;

const STANDARD_CARD_GROUPS_REGEX = /^(?:\d{4}([- ])\d{4}\1\d{4}\1\d{4}|\d{4}([- ])\d{6}\2\d{5})$/;

const SSN_CANDIDATE_AT_START_REGEX = /^(?:\d{3}-\d{2}-\d{4}|\d{3} \d{2} \d{4}|\d{9})/;

export function isEmailLocalChar(ch: string): boolean {
  return ch.length > 0 && EMAIL_LOCAL_CHAR_REGEX.test(ch);
}

export function isDisallowedNumericLeftBoundary(ch: string): boolean {
  return ch.length > 0 && NUMERIC_LEFT_DISALLOWED_REGEX.test(ch);
}

/**
 * Validates a digit-only PAN string (13-19 digits) using the ISO/IEC 7812 Luhn checksum.
 */
export function passesLuhnChecksum(digits: string): boolean {
  if (digits.length < 13 || digits.length > 19 || !/^\d+$/.test(digits)) {
    return false;
  }

  let allIdentical = true;
  for (let idx = 1; idx < digits.length; idx += 1) {
    if (digits[idx] !== digits[0]) {
      allIdentical = false;
      break;
    }
  }
  if (allIdentical) {
    return false;
  }

  let sum = 0;
  let shouldDouble = false;
  for (let idx = digits.length - 1; idx >= 0; idx -= 1) {
    let digit = digits.charCodeAt(idx) - 48;
    if (shouldDouble) {
      digit *= 2;
      if (digit > 9) {
        digit -= 9;
      }
    }
    sum += digit;
    shouldDouble = !shouldDouble;
  }

  return sum % 10 === 0;
}

/**
 * Validates US Social Security Number structural rules (SSA standard):
 * - Area (first 3 digits): 001-899 excluding 666
 * - Group (middle 2 digits): 01-99
 * - Serial (last 4 digits): 0001-9999
 */
export function isValidUsSsnDigits(digits: string): boolean {
  if (digits.length !== 9 || !/^\d{9}$/.test(digits)) {
    return false;
  }

  const area = digits.slice(0, 3);
  const group = digits.slice(3, 5);
  const serial = digits.slice(5, 9);

  if (area === '000' || area === '666' || area.startsWith('9')) {
    return false;
  }
  if (group === '00' || serial === '0000') {
    return false;
  }
  return true;
}

function tryMatchEmailAt(text: string, start: number, leftChar: string): PiiMatch | null {
  if (isEmailLocalChar(leftChar)) {
    return null;
  }

  const slice = text.slice(start, start + MAX_EMAIL_LENGTH + 1);
  const match = COMPLETE_EMAIL_AT_START_REGEX.exec(slice);
  if (!match) {
    return null;
  }

  const candidate = match[0];
  if (candidate.length > MAX_EMAIL_LENGTH) {
    return null;
  }

  const atIndex = candidate.indexOf('@');
  const localPart = candidate.slice(0, atIndex);
  if (localPart.length > MAX_EMAIL_LOCAL_LENGTH || localPart.includes('..')) {
    return null;
  }

  const end = start + candidate.length;
  const rightChar = end < text.length ? (text[end] ?? '') : '';
  if (rightChar.length > 0 && /[A-Za-z0-9_@-]/.test(rightChar)) {
    return null;
  }

  return { category: 'EMAIL', start, end };
}

function tryMatchCardAt(text: string, start: number, leftChar: string): PiiMatch | null {
  if (isDisallowedNumericLeftBoundary(leftChar)) {
    return null;
  }

  const firstChar = text[start];
  if (!firstChar || firstChar < '0' || firstChar > '9') {
    return null;
  }

  const maxEnd = Math.min(text.length, start + MAX_CARD_LENGTH);
  let separatorUsed: ' ' | '-' | null = null;
  let prevWasSeparator = false;
  let digits = '';
  let bestEnd: number | null = null;

  for (let pos = start; pos < maxEnd; pos += 1) {
    const ch = text[pos] ?? '';
    if (ch >= '0' && ch <= '9') {
      digits += ch;
      prevWasSeparator = false;
      if (digits.length > 19) {
        break;
      }

      if (digits.length >= 13) {
        const rightChar = pos + 1 < text.length ? (text[pos + 1] ?? '') : '';
        const followedByHyphenDigit =
          rightChar === '-' &&
          pos + 2 < text.length &&
          (text[pos + 2] ?? '') >= '0' &&
          (text[pos + 2] ?? '') <= '9';

        if (!NUMERIC_RIGHT_DISALLOWED_REGEX.test(rightChar) && !followedByHyphenDigit) {
          const rawCandidate = text.slice(start, pos + 1);
          const isFormattedIssuerCard =
            STANDARD_CARD_GROUPS_REGEX.test(rawCandidate) && /^[3-6]/.test(digits);
          if (passesLuhnChecksum(digits) || isFormattedIssuerCard) {
            bestEnd = pos + 1;
          }
        }
      }
    } else if (ch === ' ' || ch === '-') {
      if (prevWasSeparator) {
        break;
      }
      if (separatorUsed !== null && separatorUsed !== ch) {
        break;
      }
      separatorUsed = ch;
      prevWasSeparator = true;
    } else {
      break;
    }
  }

  if (bestEnd === null) {
    return null;
  }

  return { category: 'CREDIT_CARD', start, end: bestEnd };
}

function tryMatchSsnAt(text: string, start: number, leftChar: string): PiiMatch | null {
  if (isDisallowedNumericLeftBoundary(leftChar)) {
    return null;
  }

  const slice = text.slice(start, start + MAX_SSN_LENGTH);
  const match = SSN_CANDIDATE_AT_START_REGEX.exec(slice);
  if (!match) {
    return null;
  }

  const rawCandidate = match[0];
  const digits = rawCandidate.replace(/[- ]/g, '');
  if (!isValidUsSsnDigits(digits)) {
    return null;
  }

  const end = start + rawCandidate.length;
  const rightChar = end < text.length ? (text[end] ?? '') : '';
  if (NUMERIC_RIGHT_DISALLOWED_REGEX.test(rightChar)) {
    return null;
  }

  // Do not match the prefix of a hyphenated or space-separated longer number (e.g., 16-digit card).
  if (
    (rightChar === '-' || rightChar === ' ') &&
    end + 1 < text.length &&
    (text[end + 1] ?? '') >= '0' &&
    (text[end + 1] ?? '') <= '9'
  ) {
    return null;
  }

  return { category: 'SSN', start, end };
}

/**
 * Finds all non-overlapping complete PII matches in `text` given `prevChar` immediately
 * preceding `text[0]` (empty string if at the start of the stream).
 */
export function findPiiMatches(text: string, prevChar = ''): PiiMatch[] {
  const matches: PiiMatch[] = [];
  let index = 0;

  while (index < text.length) {
    const leftChar = index === 0 ? prevChar : (text[index - 1] ?? '');

    const emailMatch = tryMatchEmailAt(text, index, leftChar);
    if (emailMatch) {
      matches.push(emailMatch);
      index = emailMatch.end;
      continue;
    }

    const cardMatch = tryMatchCardAt(text, index, leftChar);
    if (cardMatch) {
      matches.push(cardMatch);
      index = cardMatch.end;
      continue;
    }

    const ssnMatch = tryMatchSsnAt(text, index, leftChar);
    if (ssnMatch) {
      matches.push(ssnMatch);
      index = ssnMatch.end;
      continue;
    }

    index += 1;
  }

  return matches;
}

/**
 * Determines whether `suffix` (anchored at the end of the pending buffer) could still
 * grow into a valid Email address if additional characters arrive in subsequent chunks.
 */
export function isViableEmailPrefix(suffix: string, leftChar: string): boolean {
  if (suffix.length === 0 || suffix.length > MAX_EMAIL_LENGTH) {
    return false;
  }
  if (isEmailLocalChar(leftChar)) {
    return false;
  }

  const atIndex = suffix.indexOf('@');
  if (atIndex === -1) {
    if (suffix.length > MAX_EMAIL_LOCAL_LENGTH || suffix.includes('..')) {
      return false;
    }
    return /^[A-Za-z0-9][A-Za-z0-9._%+-]*$/.test(suffix);
  }

  if (suffix.indexOf('@', atIndex + 1) !== -1) {
    return false;
  }

  const localPart = suffix.slice(0, atIndex);
  if (
    localPart.length === 0 ||
    localPart.length > MAX_EMAIL_LOCAL_LENGTH ||
    localPart.includes('..') ||
    !/^[A-Za-z0-9](?:[A-Za-z0-9._%+-]*[A-Za-z0-9_%+-])?$/.test(localPart)
  ) {
    return false;
  }

  const domainPrefix = suffix.slice(atIndex + 1);
  if (domainPrefix.length === 0) {
    return true;
  }
  if (domainPrefix.includes('..')) {
    return false;
  }

  return /^(?:[A-Za-z0-9](?:[A-Za-z0-9-]{0,61}[A-Za-z0-9])?\.)*(?:[A-Za-z0-9][A-Za-z0-9-]{0,62})?$/.test(
    domainPrefix,
  );
}

/**
 * Determines whether `suffix` (anchored at the end of the pending buffer) could still
 * grow into a valid US SSN or Credit/Debit Card number in subsequent chunks.
 */
export function isViableNumericPiiPrefix(suffix: string, leftChar: string): boolean {
  if (suffix.length === 0 || suffix.length > MAX_CARD_LENGTH) {
    return false;
  }
  if (isDisallowedNumericLeftBoundary(leftChar)) {
    return false;
  }
  if ((suffix[0] ?? '') < '0' || (suffix[0] ?? '') > '9') {
    return false;
  }

  let separatorUsed: ' ' | '-' | null = null;
  let prevWasSeparator = false;
  let digitCount = 0;

  for (let i = 0; i < suffix.length; i += 1) {
    const ch = suffix[i] ?? '';
    if (ch >= '0' && ch <= '9') {
      digitCount += 1;
      prevWasSeparator = false;
      if (digitCount > 19) {
        return false;
      }
    } else if (ch === ' ' || ch === '-') {
      if (prevWasSeparator) {
        return false;
      }
      if (separatorUsed !== null && separatorUsed !== ch) {
        return false;
      }
      separatorUsed = ch;
      prevWasSeparator = true;
    } else {
      return false;
    }
  }

  return true;
}

/**
 * Checks whether a complete match `[match.start, match.end)` inside `buffer` could still
 * be extended or altered by future chunks arriving at the end of `buffer`.
 */
export function canCompleteMatchStillExtend(buffer: string, match: PiiMatch): boolean {
  const tail = buffer.slice(match.end);
  if (tail.length === 0) {
    return true;
  }

  if (match.category === 'EMAIL') {
    if (buffer.length - match.start >= MAX_EMAIL_LENGTH) {
      return false;
    }
    return /^\.[A-Za-z0-9-]*(?:\.[A-Za-z0-9-]*)*$/.test(tail);
  }

  // SSN or CREDIT_CARD: if the remaining tail consists strictly of digits and single
  // separators within maximum card length, future digits could extend or invalidate the match.
  if (buffer.length - match.start >= MAX_CARD_LENGTH + 2) {
    return false;
  }
  return /^[- ]?\d*(?:[- ]\d*)*$/.test(tail);
}
