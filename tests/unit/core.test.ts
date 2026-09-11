import { describe, expect, it } from 'vitest';
import { assertTransition, digest, validateTargetUrl, profilePath, buildDiagnostic, checkPassword, hashPassword, canExecute } from '../../packages/core/src/index';
import type { Capability } from '../../packages/contracts/src/index';

describe('execution invariants', () => {
  it('does not turn cancellation or uncertainty into success by default', () => {
    expect(() => assertTransition('CANCELED', 'VERIFIED_SUCCEEDED')).toThrow();
    expect(() => assertTransition('UNKNOWN_OUTCOME', 'QUEUED')).toThrow();
    expect(() => assertTransition('VERIFIED_SUCCEEDED', 'SUBMITTING')).toThrow();
    expect(() => assertTransition('SUBMITTING', 'CANCELED')).toThrow();
    expect(() => assertTransition('SUBMITTING', 'UNKNOWN_OUTCOME')).not.toThrow();
  });
  it('hashes equivalent object ordering identically but preserves content changes', () => {
    expect(digest({ b: [1, 2], a: 'x' })).toBe(digest({ a: 'x', b: [1, 2] }));
    expect(digest({ body: 'hello' })).not.toBe(digest({ body: 'hello ' }));
  });
  it.each(['http://169.254.169.254/latest/meta-data', 'https://graph.facebook.com.evil.test/x', 'https://graph.facebook.com@evil.test/x', 'file:///C:/secrets', 'http://2130706433/', 'https://graph.facebook.com:444/x'])('blocks an unapproved target %s', value => {
    expect(() => validateTargetUrl(value, ['graph.facebook.com'])).toThrow();
  });
  it('restricts loopback exceptions to one explicitly configured origin', () => {
    expect(validateTargetUrl('http://127.0.0.1:4311/page', [], 'http://127.0.0.1:4311').hostname).toBe('127.0.0.1');
    expect(() => validateTargetUrl('http://127.0.0.1:3000/api', [], 'http://127.0.0.1:4311')).toThrow();
  });
  it.each(['../Default', 'C:\\Users\\Default', 'profile/../../secret', 'Default'])('rejects arbitrary profile paths %s', value => {
    expect(() => profilePath('C:/kff/profiles', value)).toThrow();
  });
  it('keeps production and synthetic capabilities separate', () => {
    const capability = { mode: 'TEST_ONLY', is_synthetic: true, evidence_state: 'IMPLEMENTED_TEST_ONLY' } as Capability;
    expect(canExecute(capability, 'PRODUCTION', true).allowed).toBe(false);
    expect(canExecute({ ...capability, is_synthetic: false }, 'TEST_ONLY', true).allowed).toBe(false);
    expect(canExecute({ ...capability, mode: 'DISABLED' }, 'TEST_ONLY', false).allowed).toBe(false);
    expect(canExecute(capability, 'TEST_ONLY', false).allowed).toBe(true);
  });
  it('exports allowlisted diagnostic facts and downgrades missing scenes', () => {
    const scope = { organization_id: 'org', brand_id: 'brand', token: 'SECRET_VALUE' };
    const bundle = buildDiagnostic({ step: 'identity', scene: { identity_count: 1, token: 999, result_count: 0 } }, 'AUTH_EXPIRED', scope, 'action');
    expect(JSON.stringify(bundle)).not.toContain('SECRET_VALUE');
    expect(bundle.files[0].content).toEqual({ identity_count: 1, result_count: 0 });
    expect(bundle.level).toBe('D1');
    expect(buildDiagnostic({ step: 'failed' }, 'ERROR', scope, 'action').level).toBe('D0');
    const metadata = buildDiagnostic({ step: 'identity', duration_ms: 25, executor_version: 'kff-agent-0.1.0_node-24.14.0' }, undefined, scope, 'action', { adapter_version: 'fixture-page-v1', attempt_id: 'attempt', outcome: 'VERIFIED_SUCCEEDED' });
    expect(metadata.schema_version).toBe('kff.diagnostic.v2'); expect(metadata.duration_ms).toBe(25); expect(metadata.outcome).toBe('VERIFIED_SUCCEEDED');
    expect(metadata.browser_version).toBeNull();
  });
  it('stores a salted password hash and rejects a wrong password', () => {
    const hash = hashPassword('a-local-test-password');
    expect(hash).not.toContain('a-local-test-password');
    expect(checkPassword('a-local-test-password', hash)).toBe(true);
    expect(checkPassword('wrong-password', hash)).toBe(false);
  });
});
