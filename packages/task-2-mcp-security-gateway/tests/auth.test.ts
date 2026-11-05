import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { TokenVerifier } from '../src/auth/token-verifier.js';
import {
  DEFAULT_LOCAL_ADMIN_TOKEN,
  DEFAULT_LOCAL_VIEWER_TOKEN,
  loadGatewayConfig,
} from '../src/config.js';

describe('TokenVerifier & Gateway Auth Config (Task 2 Authentication)', () => {
  const ADMIN_SECRET = 'test-admin-secret-token-9911';
  const VIEWER_SECRET = 'test-viewer-secret-token-2233';

  const verifier = new TokenVerifier({
    adminToken: ADMIN_SECRET,
    viewerToken: VIEWER_SECRET,
  });

  it('defaults local development tokens to admin-token and viewer-token and maps roles accurately', () => {
    expect(DEFAULT_LOCAL_ADMIN_TOKEN).toBe('admin-token');
    expect(DEFAULT_LOCAL_VIEWER_TOKEN).toBe('viewer-token');

    const config = loadGatewayConfig({}, { dotEnvPaths: [] });
    expect(config.adminToken).toBe('admin-token');
    expect(config.viewerToken).toBe('viewer-token');

    const defaultVerifier = new TokenVerifier({
      adminToken: config.adminToken,
      viewerToken: config.viewerToken,
    });

    const viewerResult = defaultVerifier.verifyAuthorizationHeader('Bearer viewer-token');
    expect(viewerResult.authenticated).toBe(true);
    if (viewerResult.authenticated) {
      expect(viewerResult.principal.role).toBe('viewer');
    }

    const adminResult = defaultVerifier.verifyAuthorizationHeader('Bearer admin-token');
    expect(adminResult.authenticated).toBe(true);
    if (adminResult.authenticated) {
      expect(adminResult.principal.role).toBe('admin');
    }
  });

  it('loads ADMIN_TOKEN and VIEWER_TOKEN from .env files while allowing explicit env overrides', () => {
    const tempDir = mkdtempSync(join(tmpdir(), 'task2-dotenv-test-'));
    try {
      const rootEnvPath = join(tempDir, '.env');
      writeFileSync(
        rootEnvPath,
        'ADMIN_TOKEN=dotenv-admin-token\nVIEWER_TOKEN=dotenv-viewer-token\nGATEWAY_PORT=4510\n',
        'utf8',
      );

      const loadedFromDotEnv = loadGatewayConfig({}, { dotEnvPaths: [rootEnvPath] });
      expect(loadedFromDotEnv.adminToken).toBe('dotenv-admin-token');
      expect(loadedFromDotEnv.viewerToken).toBe('dotenv-viewer-token');
      expect(loadedFromDotEnv.gatewayPort).toBe(4510);

      const overriddenByEnv = loadGatewayConfig(
        { VIEWER_TOKEN: 'explicit-shell-viewer-token' },
        { dotEnvPaths: [rootEnvPath] },
      );
      expect(overriddenByEnv.adminToken).toBe('dotenv-admin-token');
      expect(overriddenByEnv.viewerToken).toBe('explicit-shell-viewer-token');
    } finally {
      rmSync(tempDir, { recursive: true, force: true });
    }
  });

  it('authenticates valid admin and viewer bearer tokens with non-secret fingerprints and whitespace tolerance', () => {
    const adminRes = verifier.verifyAuthorizationHeader(`Bearer ${ADMIN_SECRET}`);
    expect(adminRes.authenticated).toBe(true);
    if (adminRes.authenticated) {
      expect(adminRes.principal.role).toBe('admin');
      expect(adminRes.principal.tokenFingerprint).toHaveLength(12);
      expect(adminRes.principal.tokenFingerprint).not.toContain(ADMIN_SECRET);
    }

    const viewerRes = verifier.verifyAuthorizationHeader(`  bearer   ${VIEWER_SECRET}  `);
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
    expect(verifier.verifyAuthorizationHeader('Bearer    ')).toEqual({
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
