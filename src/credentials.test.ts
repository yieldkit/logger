import { describe, expect, it } from 'vite-plus/test';

import {
  isSensitiveLogKey,
  isSensitiveQueryParamName,
  makeCredentialRules,
  redactLogString,
} from './credentials.ts';

/**
 * Size, in characters, of the smaller pathological input; the larger one is `SCALE_FACTOR` times
 * this.
 */
const PATHOLOGICAL_LENGTH = 20_000;

/**
 * How much larger the second input is. Linear work grows by this factor, quadratic work by its
 * square.
 */
const SCALE_FACTOR = 4;

/**
 * Largest accepted growth in run time between the two input sizes: well above linear (4x) to absorb
 * noise, well below quadratic (16x).
 */
const MAX_GROWTH = 9;

/**
 * Run time, in milliseconds, below which the larger input counts as fast whatever the growth, so
 * sub-millisecond timer noise can't fail the test.
 */
const FAST_ENOUGH_MS = 20;

/**
 * Timed runs per input; the fastest is kept so a busy machine (other suites running in parallel)
 * doesn't skew the comparison.
 */
const TIMING_RUNS = 3;

/**
 * Fastest of `TIMING_RUNS` runs of `mask` on `text`, in milliseconds.
 */
const fastestRun = (mask: (text: string) => string, text: string): number => {
  let fastest = Number.POSITIVE_INFINITY;
  for (let run = 0; run < TIMING_RUNS; run += 1) {
    const start = performance.now();
    mask(text);
    fastest = Math.min(fastest, performance.now() - start);
  }

  return fastest;
};

/**
 * How much `mask`'s run time grows when the input built by `build` grows by `SCALE_FACTOR`; `1`
 * when the larger input is fast enough that the ratio would only measure timer noise. Comparing two
 * sizes rather than a wall-clock budget keeps the check independent of machine load.
 */
const timeGrowth = (mask: (text: string) => string, build: (length: number) => string): number => {
  const small = fastestRun(mask, build(PATHOLOGICAL_LENGTH));
  const large = fastestRun(mask, build(PATHOLOGICAL_LENGTH * SCALE_FACTOR));
  return large < FAST_ENOUGH_MS ? 1 : large / Math.max(small, Number.EPSILON);
};

/**
 * The convenience shapes: input, then the expected output.
 */
const MASKED: ReadonlyArray<readonly [string, string]> = [
  [
    'https://h.example/cb#access_token=S0&state=1',
    'https://h.example/cb#access_token=<redacted>&state=1',
  ],
  [
    'https://h.example/cb?client_secret=S1&page=2',
    'https://h.example/cb?client_secret=<redacted>&page=2',
  ],
  ['https://h.example/?api-key=S2&x=1', 'https://h.example/?api-key=<redacted>&x=1'],
  ["https://h.example/?password=ab'S3&x=1", 'https://h.example/?password=<redacted>&x=1'],
  ['sent Authorization: Bearer "S4"', 'sent Authorization: Bearer "<redacted>"'],
  ["retry with bearer 'S5'", "retry with bearer '<redacted>'"],
  ['auth Basic dXNlcjpwYXNz, then', 'auth Basic <redacted>, then'],
  [
    'connect postgres://app:S6@db:5432/main failed',
    'connect postgres://<redacted>@db:5432/main failed',
  ],
  ['redis://:S7@cache:6379', 'redis://<redacted>@cache:6379'],
  ['amqp://u:p@ss#S8@mq/vhost', 'amqp://<redacted>@mq/vhost'],
];

/**
 * Text that comes back unchanged: ordinary prose, and the shapes the contract leaves out.
 */
const UNCHANGED: ReadonlyArray<string> = [
  'cache miss key=user:42 sort_key=name auth=oidc',
  'see https://example.com/a?page=2&sort=asc#frag',
  'user bob@example.com logged in at 10:30',
  'https://example.com/@scope/pkg',
  'host=db password=hunter2 user=app',
  '{"password":"hunter2"}',
  'Authorization: Token abc',
  'TokenExpiredError: jwt expired',
];

describe('isSensitiveLogKey', () => {
  it.each([
    'client_secret',
    'clientSecret',
    'X-Api-Key',
    'api.key',
    'api key',
    'set-cookie',
    'sessionId',
    'db_pwd',
    'idJwt',
    'tokenCount',
    'tokenType',
  ])('accepts %j', (key) => {
    expect(isSensitiveLogKey(key)).toBe(true);
  });

  it.each(['email', 'code', 'cacheKey', 'idempotencyKey', 'publicKey', 'monkey', 'author'])(
    'rejects %j',
    (key) => {
      expect(isSensitiveLogKey(key)).toBe(false);
    },
  );
});

describe('masksEntry', () => {
  const rules = makeCredentialRules({
    sensitiveKeys: ['customerRef', 'accountCount', /^x-internal-/i],
    allowKeys: ['tokenType', 'expires_in', 'accountCount'],
  });

  it('keeps a number or boolean under a built-in name and masks everything else', () => {
    expect(rules.masksEntry('tokenCount', 1200)).toBe(false);
    expect(rules.masksEntry('sessionActive', true)).toBe(false);
    expect(rules.masksEntry('tokenCount', '1200')).toBe(true);
    expect(rules.masksEntry('tokens', { input: 1, output: 2 })).toBe(true);
    expect(rules.masksEntry('tokens', [1, 2])).toBe(true);
    expect(rules.masksEntry('token', 10n)).toBe(true);
    expect(rules.masksEntry('sessionStart', new Date(0))).toBe(true);
  });

  it('never masks null or undefined', () => {
    expect(rules.masksEntry('password', null)).toBe(false);
    expect(rules.masksEntry('customerRef', undefined)).toBe(false);
  });

  it('always masks a configured key, numbers and booleans included', () => {
    expect(rules.masksEntry('customer_ref', 42)).toBe(true);
    expect(rules.masksEntry('X-Internal-Trace', false)).toBe(true);
    expect(rules.isSensitiveKey('CUSTOMER-REF')).toBe(true);
  });

  it('exempts an allowed key by its whole normalized name, unless it is also configured', () => {
    expect(rules.masksEntry('token_type', 'bearer')).toBe(false);
    expect(rules.masksEntry('expiresIn', '30s')).toBe(false);
    expect(rules.masksEntry('refreshTokenType', 'bearer')).toBe(true);
    expect(rules.masksEntry('accountCount', 5)).toBe(true);
  });

  it('leaves the built-in list of other rule sets alone', () => {
    expect(makeCredentialRules().masksEntry('tokenType', 'bearer')).toBe(true);
    expect(isSensitiveLogKey('customerRef')).toBe(false);
  });

  it('judges query parameter names like keys', () => {
    expect(rules.redactText('GET /x?customer_ref=c1&tokenType=bearer&token=t1')).toBe(
      'GET /x?customer_ref=<redacted>&tokenType=bearer&token=<redacted>',
    );
  });
});

describe('redactLogString', () => {
  it.each(MASKED)('masks %j', (text, masked) => {
    expect(redactLogString(text)).toBe(masked);
  });

  it.each(UNCHANGED)('leaves %j unchanged', (text) => {
    expect(redactLogString(text)).toBe(text);
  });

  it('masks a query value whose name is encoded with +', () => {
    expect(isSensitiveQueryParamName('access+token')).toBe(true);
    expect(redactLogString('https://h/cb?access+token=plus-secret&x=1')).toBe(
      'https://h/cb?access+token=<redacted>&x=1',
    );
  });

  it('returns the same text when run twice', () => {
    for (const [text] of MASKED) {
      const once = redactLogString(text);
      expect(redactLogString(once)).toBe(once);
    }
  });

  it.each<[string, (length: number) => string]>([
    ['dotted run', (length) => 'a.'.repeat(length / 2)],
    ['repeated matrix tokens', (length) => 'https://h/?' + 'token=a;'.repeat(length / 8)],
    ['repeated query names', (length) => '?'.repeat(length)],
    ['repeated bearer words', (length) => 'Bearer '.repeat(length / 7)],
    ['scheme run', (length) => 'a://'.repeat(length / 4)],
    ['userinfo run', (length) => `x://${'a@'.repeat(length / 2)}`],
  ])('masks a %s in linear time', (_label, build) => {
    expect(timeGrowth(redactLogString, build)).toBeLessThan(MAX_GROWTH);
  });
});

describe('query parameter names', () => {
  it('masks short credential names, signed-URL names and sensitive keys in a logged URL', () => {
    expect(
      redactLogString(
        'GET https://h.test/cb?key=k1&sig=s1&code=c1&X-Amz-Signature=a1&api%5Fkey=p1&page=2&q=x',
      ),
    ).toBe(
      'GET https://h.test/cb?key=<redacted>&sig=<redacted>&code=<redacted>&X-Amz-Signature=<redacted>&api%5Fkey=<redacted>&page=2&q=x',
    );
  });

  it('accepts the documented names in any case, decoded, and keeps ordinary ones', () => {
    for (const name of ['KEY', 'Signature', 'x-goog-signature', 'access_token', 'api%5Fkey']) {
      expect(isSensitiveQueryParamName(name)).toBe(true);
    }

    for (const name of ['page', 'q', 'state', 'keyword', 'sort_key']) {
      expect(isSensitiveQueryParamName(name)).toBe(false);
    }
  });

  it('adds configured sensitive keys', () => {
    const rules = makeCredentialRules({ sensitiveKeys: ['customerRef'] });
    expect(rules.isSensitiveQueryParamName('customer_ref')).toBe(true);
  });
});

describe('scrubText', () => {
  it('runs after the built-in shapes', () => {
    const rules = makeCredentialRules({
      scrubText: (text) => text.replaceAll(/sk_live_\w+/g, '<redacted>'),
    });
    expect(rules.redactText('key sk_live_abc and Bearer t1')).toBe(
      'key <redacted> and Bearer <redacted>',
    );
  });

  it('writes the text as <redacted> when it throws', () => {
    const rules = makeCredentialRules({
      scrubText: () => {
        throw new Error('boom');
      },
    });
    expect(rules.redactText('anything')).toBe('<redacted>');
  });
});

describe('URL userinfo', () => {
  it('masks the same spans as the userinfo pattern, for any arrangement of URL characters', () => {
    const pattern = /(?<![a-z0-9+.-])([a-z][a-z0-9+.-]*:\/\/)([^\s/]*)@/gi;
    const pieces = ['a', 'Z', '1', '+', '.', '-', ':', '/', '@', ' ', '\n', '?', '#', 'h', '://'];
    let seed = 7;
    const next = (): number => {
      seed = (seed * 1_103_515_245 + 12_345) % 2_147_483_648;
      return seed / 2_147_483_648;
    };
    for (let round = 0; round < 3000; round += 1) {
      let text = '';
      const length = Math.floor(next() * 40);
      for (let index = 0; index < length; index += 1) {
        text += pieces[Math.floor(next() * pieces.length)] ?? 'a';
      }

      const expected = text.replaceAll(
        pattern,
        (_match, scheme: string, info: string) =>
          `${scheme}${info.length > 0 ? '<redacted>' : ''}@`,
      );
      expect(redactLogString(text)).toBe(expected);
    }
  });
});
