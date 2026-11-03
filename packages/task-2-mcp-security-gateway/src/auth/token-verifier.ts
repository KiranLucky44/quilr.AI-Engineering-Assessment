import { createHash, timingSafeEqual } from 'node:crypto';
import type { AuthenticatedPrincipal, Role } from './roles.js';

export interface TokenRoleConfig {
  readonly adminToken: string;
  readonly viewerToken: string;
}

interface HashedTokenEntry {
  readonly digest: Buffer;
  readonly fingerprint: string;
  readonly role: Role;
}

export type TokenVerificationResult =
  | {
      readonly authenticated: true;
      readonly principal: AuthenticatedPrincipal;
    }
  | {
      readonly authenticated: false;
      readonly reason: 'MISSING_HEADER' | 'MALFORMED_HEADER' | 'INVALID_TOKEN';
    };

function sha256Buffer(value: string): Buffer {
  return createHash('sha256').update(value, 'utf8').digest();
}

/**
 * Development-only static token-to-role verifier.
 *
 * SECURITY PROPERTIES:
 * - Plaintext tokens are hashed immediately with SHA-256 at initialization and never stored or logged.
 * - Incoming bearer tokens are compared using constant-time `timingSafeEqual` over fixed-length
 *   32-byte digests, eliminating token-length timing side channels.
 * - LIMITATION: Static bearer tokens are purely for local demonstration/testing; production
 *   deployments should verify short-lived signed JWTs (OIDC/JWKS) or mTLS client certificates.
 */
export class TokenVerifier {
  private readonly entries: readonly HashedTokenEntry[];

  public constructor(config: TokenRoleConfig) {
    const adminTrimmed = config.adminToken.trim();
    const viewerTrimmed = config.viewerToken.trim();

    if (adminTrimmed.length === 0 || viewerTrimmed.length === 0) {
      throw new Error('ADMIN_TOKEN and VIEWER_TOKEN must be non-empty strings.');
    }

    if (adminTrimmed === viewerTrimmed) {
      throw new Error('ADMIN_TOKEN and VIEWER_TOKEN must be distinct values.');
    }

    const adminDigest = sha256Buffer(adminTrimmed);
    const viewerDigest = sha256Buffer(viewerTrimmed);

    this.entries = [
      {
        digest: adminDigest,
        fingerprint: adminDigest.toString('hex').slice(0, 12),
        role: 'admin',
      },
      {
        digest: viewerDigest,
        fingerprint: viewerDigest.toString('hex').slice(0, 12),
        role: 'viewer',
      },
    ];
  }

  public verifyAuthorizationHeader(headerValue: string | undefined): TokenVerificationResult {
    if (headerValue === undefined || headerValue.trim().length === 0) {
      return { authenticated: false, reason: 'MISSING_HEADER' };
    }

    const parts = headerValue.trim().split(' ');
    if (parts.length !== 2) {
      return { authenticated: false, reason: 'MALFORMED_HEADER' };
    }

    const [scheme, rawToken] = parts;
    if (!scheme || scheme.toLowerCase() !== 'bearer' || !rawToken || rawToken.length === 0) {
      return { authenticated: false, reason: 'MALFORMED_HEADER' };
    }

    const candidateDigest = sha256Buffer(rawToken);
    let matchedEntry: HashedTokenEntry | null = null;

    // Evaluate every entry without short-circuiting to maintain uniform timing.
    for (const entry of this.entries) {
      if (timingSafeEqual(candidateDigest, entry.digest)) {
        matchedEntry = entry;
      }
    }

    if (!matchedEntry) {
      return { authenticated: false, reason: 'INVALID_TOKEN' };
    }

    return {
      authenticated: true,
      principal: {
        role: matchedEntry.role,
        tokenFingerprint: matchedEntry.fingerprint,
      },
    };
  }
}
