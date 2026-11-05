import { describe, expect, it } from 'vitest';
import { StreamingRedactor } from '../src/streaming/streaming-redactor.js';

function streamChunks(chunks: readonly string[]): {
  fullOutput: string;
  emittedPieces: string[];
} {
  const redactor = new StreamingRedactor();
  const emittedPieces: string[] = [];

  for (const chunk of chunks) {
    const piece = redactor.push(chunk);
    if (piece.length > 0) {
      emittedPieces.push(piece);
    }
  }
  const flushed = redactor.flush();
  if (flushed.length > 0) {
    emittedPieces.push(flushed);
  }

  return {
    fullOutput: emittedPieces.join(''),
    emittedPieces,
  };
}

describe('Exhaustive Split-Boundary & Multi-Chunk Redaction Suite (Task 3)', () => {
  const SENSITIVE_FIXTURES = [
    {
      label: 'standard email',
      secret: 'john.doe@gmail.com',
      secretFragments: ['john.doe@', '@gmail.com'],
    },
    {
      label: 'multi-subdomain long email',
      secret: 'security.notifications+prod-alert@sub1.sub2.quill-platform.co.uk',
      secretFragments: ['security.notifications+prod-alert@', 'quill-platform.co.uk'],
    },
    {
      label: 'hyphenated US SSN',
      secret: '123-45-6789',
      secretFragments: ['123-45-', '-45-6789'],
    },
    {
      label: 'space-separated US SSN',
      secret: '123 45 6789',
      secretFragments: ['123 45 ', ' 45 6789'],
    },
    {
      label: 'unseparated 9-digit US SSN',
      secret: '123456789',
      secretFragments: ['123456789'],
    },
    {
      label: 'continuous 16-digit Visa card',
      secret: '4111111111111111',
      secretFragments: ['4111111111111111', '111111111111'],
    },
    {
      label: 'hyphenated 16-digit Mastercard',
      secret: '5555-5555-5555-4444',
      secretFragments: ['5555-5555', '5555-4444'],
    },
    {
      label: 'space-separated 16-digit Visa card',
      secret: '4111 1111 1111 1111',
      secretFragments: ['4111 1111', '1111 1111'],
    },
    {
      label: '15-digit Amex card',
      secret: '3782-822463-10005',
      secretFragments: ['3782-822463', '822463-10005'],
    },
  ] as const;

  for (const fixture of SENSITIVE_FIXTURES) {
    it(`exhaustively redacts ${fixture.label} across EVERY possible 2-chunk split position`, () => {
      const fullMessage = `Customer record reference: ${fixture.secret}. Please review.`;
      const expected = 'Customer record reference: [REDACTED]. Please review.';

      for (let splitPos = 0; splitPos <= fullMessage.length; splitPos += 1) {
        const chunkA = fullMessage.slice(0, splitPos);
        const chunkB = fullMessage.slice(splitPos);

        const { fullOutput, emittedPieces } = streamChunks([chunkA, chunkB]);
        expect(fullOutput).toBe(expected);
        expect(fullOutput).not.toContain(fixture.secret);

        for (const piece of emittedPieces) {
          expect(piece).not.toContain(fixture.secret);
          for (const frag of fixture.secretFragments) {
            expect(piece).not.toContain(frag);
          }
        }
      }
    });
  }

  it('redacts email, SSN, and credit card across every 3-chunk split of the secret itself', () => {
    const cases = [
      { secret: 'john@gmail.com', forbiddenFragments: ['john', '@gmail', 'gmail.com'] },
      { secret: '123-45-6789', forbiddenFragments: ['123', '45-', '6789'] },
      { secret: '4111-1111-1111-1111', forbiddenFragments: ['4111', '1111'] },
    ] as const;

    for (const { secret, forbiddenFragments } of cases) {
      for (let i = 1; i < secret.length - 1; i += 1) {
        for (let j = i + 1; j < secret.length; j += 1) {
          const chunks = [
            `Prefix ${secret.slice(0, i)}`,
            secret.slice(i, j),
            `${secret.slice(j)} suffix.`,
          ];
          const { fullOutput, emittedPieces } = streamChunks(chunks);
          expect(fullOutput).toBe('Prefix [REDACTED] suffix.');
          expect(fullOutput).not.toContain(secret);

          for (const piece of emittedPieces) {
            expect(piece).not.toContain(secret);
            for (const frag of forbiddenFragments) {
              expect(piece).not.toContain(frag);
            }
          }
        }
      }
    }
  });

  it('redacts combined multi-PII message fed strictly 1 character per chunk', () => {
    const raw =
      'Single-char stream: email user.one@sub.domain.org, SSN 123-45-6789, card 4111 1111 1111 1111!';
    const singleCharChunks = Array.from(raw);
    const { fullOutput, emittedPieces } = streamChunks(singleCharChunks);

    expect(fullOutput).toBe(
      'Single-char stream: email [REDACTED], SSN [REDACTED], card [REDACTED]!',
    );

    const forbiddenFragments = [
      'user.one',
      '@sub',
      'domain.org',
      '123-',
      '45-6789',
      '4111',
      '1111',
    ];
    for (const piece of emittedPieces) {
      for (const frag of forbiddenFragments) {
        expect(piece).not.toContain(frag);
      }
    }
  });
});
