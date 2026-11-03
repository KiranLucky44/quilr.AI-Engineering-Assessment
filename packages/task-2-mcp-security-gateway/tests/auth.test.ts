import { describe, expect, it } from 'vitest';
import { TokenVerifier } from '../src/auth/token-verifier.js';

describe('TokenVerifier (Task 2 Authentication)', () => {
  const ADMIN_SECRET = 'test-admin-secret-token-9911';
  const VIEWER_SECRET = 'test-viewer-secret-token-2233';

  const verifier = new TokenVerifier({
    adminToken: ADMIN_SECRET,
    viewerToken: VIEWER_SECRET,
  });

  it('authenticates valid admin and viewer bearer tokens with non-secret fingerprints', () => {
    const adminRes = verifier.verifyAuthorizationHeader(`Bearer ${ADMIN_SECRET}`);
    expect(adminRes.authenticated).toBe(true);
    if (adminRes.authenticated) {
      expect(adminRes.principal.role).toBe('admin');
      expect(adminRes.principal.tokenFingerprint).toHaveLength(12);
      expect(adminRes.principal.tokenFingerprint).not.toContain(ADMIN_SECRET);
    }

    const viewerRes = verifier.verifyAuthorizationHeader(`bearer ${VIEWER_SECRET}`);
    expect(viewerRes.authenticated).toBe(true);
    if (viewerRes.authenticated) {
      expect(viewerRes.principal.role).toBe('viewer');
    }
  });

  it('rejects missing, empty, or malformed Authorization headers', () => {
    expect(verifier.verifyAuthorizationHeader(undefined)).toEqual({
      authenticated: false,
      reason: 'MISSING_HEADER',
    });
    expect(verifier.verifyAuthorizationHeader('   ')).toEqual({
      authenticated: false,
      reason: 'MISSING_HEADER',
    });
    expect(verifier.verifyAuthorizationHeader(`Basic ${ADMIN_SECRET}`)).toEqual({
      authenticated: false,
      reason: 'MALFORMED_HEADER',
    });
    expect(verifier.verifyAuthorizationHeader('Bearer')).toEqual({
      authenticated: false,
      reason: 'MALFORMED_HEADER',
    });
    expect(verifier.verifyAuthorizationHeader(`Bearer ${ADMIN_SECRET} extra`)).toEqual({
      authenticated: false,
      reason: 'MALFORMED_HEADER',
    });
  });

  it('rejects unknown bearer tokens', () => {
    expect(verifier.verifyAuthorizationHeader('Bearer wrong-token')).toEqual({
      authenticated: false,
      reason: 'INVALID_TOKEN',
    });
  });

  it('does not retain plaintext tokens in verifier instance properties', () => {
    const serialized = JSON.stringify(verifier);
    expect(serialized).not.toContain(ADMIN_SECRET);
    expect(serialized).not.toContain(VIEWER_SECRET);
  });

  it('rejects empty or identical admin and viewer tokens at configuration time', () => {
    expect(() => new TokenVerifier({ adminToken: '', viewerToken: 'v' })).toThrow();
    expect(() => new TokenVerifier({ adminToken: 'same', viewerToken: 'same' })).toThrow();
  });
});
