import { Cause, Data, Redactable } from 'effect';
import { describe, expect, it } from 'vite-plus/test';

import { describeError, extractCauseSummary, extractErrorFields } from './error.ts';
import { sanitizeCause } from './redact.ts';

class UpstreamTestError extends Data.TaggedError('UpstreamTestError')<{
  readonly message: string;
  readonly status: number;
}> {}

describe('describeError', () => {
  it('reads the message from a tagged error', () => {
    const err = new UpstreamTestError({ message: 'Rate limited upstream', status: 429 });
    expect(describeError(err)).toBe('Rate limited upstream');
  });
});

describe('extractCauseSummary', () => {
  it('prefers the fail reason and copies tag, name, and status', () => {
    const err = new UpstreamTestError({ message: 'Rate limited upstream', status: 429 });
    expect(extractCauseSummary(Cause.fail(err))).toEqual({
      kind: 'fail',
      tag: 'UpstreamTestError',
      name: 'UpstreamTestError',
      message: 'Rate limited upstream',
      status: 429,
    });
  });
});

/**
 * Class with a secret field and no `message` or `_tag`.
 */
class LoginAttempt {
  readonly user: string;
  readonly password: string;

  constructor(fields: { readonly user: string; readonly password: string }) {
    this.user = fields.user;
    this.password = fields.password;
  }
}

/**
 * Class whose own `toString` prints the secret it holds.
 */
class LeakyValue {
  readonly apiKey: string;

  constructor(apiKey: string) {
    this.apiKey = apiKey;
  }

  toString(): string {
    return `LeakyValue(apiKey=${this.apiKey})`;
  }
}

describe('describeError on values without a message', () => {
  it('renders the redacted fields instead of the value’s own toString', () => {
    expect(describeError(new LoginAttempt({ user: 'u', password: 'login-secret' }))).toBe(
      'LoginAttempt {"user":"u","password":"<redacted>"}',
    );
    expect(describeError(new LeakyValue('leaky-secret'))).toBe(
      'LeakyValue {"apiKey":"<redacted>"}',
    );
    expect(extractErrorFields(new LeakyValue('leaky-secret'))).toEqual({});
  });

  it('keeps primitives and plain objects readable', () => {
    expect(describeError('plain text')).toBe('plain text');
    expect(describeError(42)).toBe('42');
    expect(describeError({ reason: 'timeout' })).toBe('{"reason":"timeout"}');
  });

  it('never throws on a value it cannot read', () => {
    const revoked = Proxy.revocable({}, {});
    revoked.revoke();
    expect(() => describeError(Object.create(null))).not.toThrow();
    expect(describeError(revoked.proxy)).toBe('[Unserializable]');
    expect(extractErrorFields(Object.create(null))).toEqual({});
  });
});

describe('extractCauseSummary masking', () => {
  it('masks credentials in the tag and name as well as the message', () => {
    const error = Object.assign(new Error('upstream failed'), {
      _tag: 'Upstream https://u:tag-secret@h.example/',
    });
    error.name = 'Name https://u:name-secret@h.example/';
    expect(extractCauseSummary(Cause.fail(error))).toEqual({
      kind: 'fail',
      message: 'upstream failed',
      tag: 'Upstream https://<redacted>@h.example/',
      name: 'Name https://<redacted>@h.example/',
    });
  });
});

describe('Redactable errors', () => {
  /**
   * Error that hides its message through Effect's `Redactable` protocol.
   */
  class OpaqueError extends Error {
    /**
     * The form logged in place of this error.
     */
    [Redactable.symbolRedactable]() {
      return { name: 'OpaqueError', message: 'hidden' };
    }
  }

  it('summarizes the redacted form of a Redactable error', () => {
    const error = new OpaqueError('xK9opaqueCRED77');
    expect(extractErrorFields(error)).toEqual({ errorMessage: 'hidden', errorName: 'OpaqueError' });
    expect(extractCauseSummary(Cause.fail(error))?.message).toBe('hidden');
    expect(describeError(error)).toBe('hidden');
  });

  it('renders the redacted form in a sanitized cause', () => {
    const rendered = Cause.pretty(sanitizeCause(Cause.die(new OpaqueError('xK9opaqueCRED77'))));
    expect(rendered).not.toContain('xK9opaqueCRED77');
    expect(rendered).toContain('hidden');
  });
});
