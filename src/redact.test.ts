import {
  Cause,
  Context,
  Data,
  Effect,
  Exit,
  Logger,
  Predicate,
  Redactable,
  Redacted,
  References,
  Schema,
  Tracer,
} from 'effect';
import { Headers } from 'effect/http';
import { describe, expect, it } from 'vite-plus/test';

import { REDACTED_LOG_VALUE, isSensitiveLogKey, redactLogString } from './credentials.ts';
import {
  guardLogger,
  overrideFiberRefs,
  redactLogValue,
  sanitizeCause,
  withRedaction,
  withTracerRedaction,
} from './redact.ts';

/**
 * Failure raised inside a span in the stack-frame tests.
 */
class BoomError extends Data.TaggedError('BoomError') {}

/**
 * Object that may point back at itself through `self`.
 */
interface Cyclic {
  readonly n: number;
  self?: Cyclic;
}

/**
 * Chain of objects linked through `next`, ending in a `leaf`.
 */
interface Nested {
  readonly leaf?: true;
  readonly next?: Nested;
}

describe('isSensitiveLogKey', () => {
  it('matches secret keys in any casing or style', () => {
    const keys = [
      'client_secret',
      'clientSecret',
      'X-Api-Key',
      'Authorization',
      'set-cookie',
      'sessionId',
      'password',
      'passwd',
      'refreshToken',
      'private_key',
      'tokens',
      'tokenCount',
    ];
    expect(keys.filter((key) => !isSensitiveLogKey(key))).toEqual([]);
  });

  it('leaves email, phone and other ordinary keys alone', () => {
    const keys = ['expiresIn', 'email', 'phone', 'cacheKey', 'code'];
    expect(keys.filter(isSensitiveLogKey)).toEqual([]);
  });
});

describe('redactLogString', () => {
  it('masks bearer and basic credentials', () => {
    expect(redactLogString('call failed: Bearer abc.def-123, retrying')).toBe(
      'call failed: Bearer <redacted>, retrying',
    );
    expect(redactLogString('header Basic dXNlcjpwYXNz')).toBe('header Basic <redacted>');
  });

  it('masks URL userinfo and credential query values', () => {
    expect(redactLogString('connect postgres://app:hunter2@db:5432/main failed')).toBe(
      'connect postgres://<redacted>@db:5432/main failed',
    );
    expect(redactLogString('GET https://api.test/items?page=2&token=tok-123&sig=s1#top')).toBe(
      'GET https://api.test/items?page=2&token=<redacted>&sig=<redacted>#top',
    );
  });

  it('masks a password containing a raw @ in full', () => {
    expect(redactLogString('connect postgres://app:p@ss@db:5432/main failed')).toBe(
      'connect postgres://<redacted>@db:5432/main failed',
    );
  });

  it('masks a password containing ?, # or quotes in full', () => {
    expect(redactLogString(`connect postgres://app:a?b#c"d'e@db:5432/main failed`)).toBe(
      'connect postgres://<redacted>@db:5432/main failed',
    );
  });

  it('checks every parameter after a matrix separator or a nested URL', () => {
    expect(redactLogString('https://h.test/p?a=1;token=x')).toBe(
      'https://h.test/p?a=1;token=<redacted>',
    );
    expect(redactLogString('https://h.test/login?next=https://h/cb?token=x')).toBe(
      'https://h.test/login?next=https://h/cb?token=<redacted>',
    );
  });

  it('masks a sensitive value whole when it contains ; or ?', () => {
    expect(redactLogString('https://h.test/p?token=a;b&page=2')).toBe(
      'https://h.test/p?token=<redacted>&page=2',
    );
    expect(redactLogString('https://h.test/p?password=ab?cd')).toBe(
      'https://h.test/p?password=<redacted>',
    );
  });

  it('masks a query value holding @ before reading URL userinfo', () => {
    expect(redactLogString('GET https://h?password=p@ss done')).toBe(
      'GET https://h?password=<redacted> done',
    );
  });

  it('masks any query parameter whose name is a sensitive key', () => {
    expect(
      redactLogString(
        'GET https://b.test/o?X-Amz-Signature=abc&client_secret=s&x-api-key=k&page=2',
      ),
    ).toBe(
      'GET https://b.test/o?X-Amz-Signature=<redacted>&client_secret=<redacted>&x-api-key=<redacted>&page=2',
    );
    expect(redactLogString('https://idp.test/cb?code=c1&state=ok&tokenType=bearer')).toBe(
      'https://idp.test/cb?code=<redacted>&state=ok&tokenType=<redacted>',
    );
  });

  it('returns the same text when run twice', () => {
    const once = redactLogString('Bearer abc https://u:p@h/x?token=t');
    expect(redactLogString(once)).toBe(once);
  });
});

describe('redactLogValue', () => {
  it('masks sensitive keys nested in objects and arrays', () => {
    const input = {
      headers: { Authorization: 'Bearer cap-A', 'X-Api-Key': 'key-1', accept: 'json' },
      auth0: { clientId: 'visible-id', clientSecret: 'camel-secret' },
      list: [{ password: 'pw-in-array', name: 'n' }],
      empty: { token: null, session: undefined },
      usage: { tokenCount: 12, tokenType: 'Bearer', expiresIn: 3600, tokens: 1024 },
    };
    expect(redactLogValue(input)).toEqual({
      headers: {
        Authorization: REDACTED_LOG_VALUE,
        'X-Api-Key': REDACTED_LOG_VALUE,
        accept: 'json',
      },
      auth0: { clientId: 'visible-id', clientSecret: REDACTED_LOG_VALUE },
      list: [{ password: REDACTED_LOG_VALUE, name: 'n' }],
      empty: { token: null, session: undefined },
      usage: { tokenCount: 12, tokenType: REDACTED_LOG_VALUE, expiresIn: 3600, tokens: 1024 },
    });
    expect(input.headers.Authorization).toBe('Bearer cap-A');
  });

  it('masks credentials inside string values', () => {
    expect(redactLogValue({ note: 'sent Bearer abc123', url: 'https://u:p@host/x' })).toEqual({
      note: 'sent Bearer <redacted>',
      url: 'https://<redacted>@host/x',
    });
  });

  it('cuts cycles and caps depth', () => {
    const cyclic: Cyclic = { n: 1 };
    cyclic.self = cyclic;
    expect(redactLogValue(cyclic)).toEqual({ n: 1, self: '[Circular]' });

    let deep: Nested = { leaf: true };
    for (let level = 0; level < 12; level += 1) {
      deep = { next: deep };
    }

    expect(JSON.stringify(redactLogValue(deep))).toContain('[Truncated]');
  });

  it('keeps a shared object that is not an ancestor', () => {
    const shared = { id: 1 };
    expect(redactLogValue({ a: shared, b: shared })).toEqual({ a: { id: 1 }, b: { id: 1 } });
  });

  it('keeps Redacted, Date and bigint values and converts Map, Set and Error', () => {
    const wrapped = Redacted.make('hunter2');
    const date = new Date(0);
    const error = Object.assign(new Error('failed with Bearer abc'), { apiKey: 'k', code: 7 });
    const output = redactLogValue({
      wrapped,
      date,
      big: 10n,
      map: new Map<unknown, unknown>([
        ['password', 'p'],
        [1, 'one'],
      ]),
      set: new Set(['Bearer zzz']),
      error,
    });
    expect(output).toEqual({
      wrapped,
      date,
      big: 10n,
      map: { password: REDACTED_LOG_VALUE, 1: 'one' },
      set: ['Bearer <redacted>'],
      error: {
        name: 'Error',
        message: 'failed with Bearer <redacted>',
        apiKey: REDACTED_LOG_VALUE,
        code: 7,
      },
    });
    expect(Predicate.hasProperty(output, 'wrapped') && Redacted.isRedacted(output.wrapped)).toBe(
      true,
    );
  });

  it('replaces a Redactable value with its redacted form', () => {
    class Credential {
      readonly raw = 'redactable-secret';
      readonly [Redactable.symbolRedactable] = () => ({ kind: 'credential', raw: '<hidden>' });
    }
    expect(redactLogValue({ c: new Credential() })).toEqual({
      c: { kind: 'credential', raw: '<hidden>' },
    });
  });

  it('masks an object that only claims to be Redacted', () => {
    const fake = Schema.decodeSync(Schema.fromJsonString(Schema.Unknown))(
      '{"~effect/Redacted": 1, "password": "fake-secret"}',
    );
    expect(redactLogValue({ body: fake })).toEqual({ body: REDACTED_LOG_VALUE });
    const labelled = Redacted.make('x', { label: 'db' });
    expect(redactLogValue({ labelled })).toEqual({ labelled });
  });

  it('masks a list of tokens under a built-in name but keeps numbers and booleans', () => {
    expect(redactLogValue({ tokens: ['tok-live-1', 'tok-live-2'] })).toEqual({
      tokens: REDACTED_LOG_VALUE,
    });
    expect(redactLogValue({ tokens: 12, sessionActive: false, session_timeout: '30s' })).toEqual({
      tokens: 12,
      sessionActive: false,
      session_timeout: REDACTED_LOG_VALUE,
    });
    expect(redactLogValue({ tokens: { input: 3, output: 4 } })).toEqual({
      tokens: REDACTED_LOG_VALUE,
    });
  });

  it('never throws on a value it cannot read', () => {
    const revoked = Proxy.revocable({}, {});
    revoked.revoke();
    const throwing = {
      ok: 1,
      get broken(): never {
        throw new Error('getter failed');
      },
    };
    const output = redactLogValue({
      revoked: revoked.proxy,
      throwing,
      map: new Map<unknown, unknown>([[Object.create(null), 1]]),
    });
    expect(output).toEqual({
      revoked: '[Unserializable]',
      throwing: { ok: 1, broken: '[Unserializable]' },
      map: { '[Unserializable]': 1 },
    });
  });

  it('uses toJSON and survives one that throws', () => {
    const good = { toJSON: () => ({ password: 'p', ok: 1 }) };
    const bad = {
      toJSON: (): never => {
        throw new Error('nope');
      },
    };
    expect(redactLogValue({ good, bad })).toEqual({
      good: { password: REDACTED_LOG_VALUE, ok: 1 },
      bad: '[Unserializable]',
    });
  });
});

describe('sanitizeCause', () => {
  it('redacts an Error message, stack and cause chain, cutting cycles', () => {
    const inner = new Error('upstream https://u:secret-pw@h/x', {
      cause: { authorization: 'secret-header' },
    });
    const outer = new Error('request failed with Bearer abc.def', { cause: inner });
    const rendered = Cause.pretty(sanitizeCause(Cause.fail(outer)));
    expect(rendered).toContain('request failed with Bearer <redacted>');
    for (const leaked of ['abc.def', 'secret-pw', 'secret-header']) {
      expect(rendered).not.toContain(leaked);
    }

    const a = new Error('a');
    const b = new Error('b', { cause: a });
    Reflect.set(a, 'cause', b);
    const cyclic = Cause.pretty(sanitizeCause(Cause.die(a)));
    expect(cyclic).toContain('[cause]: Error: b');
    expect(cyclic).toContain('[Circular]');
  });

  it('renders a Redactable error, or one in a cause chain, from its redacted form', () => {
    class LeakyError extends Error {
      readonly [Redactable.symbolRedactable] = () => new Error('hidden form');
    }
    const outer = new Error('outer', { cause: new LeakyError('secret-in-message') });
    const rendered = Cause.pretty(sanitizeCause(Cause.fail(new LeakyError('top-secret'))));
    expect(rendered).toContain('hidden form');
    expect(rendered).not.toContain('top-secret');
    const chained = Cause.pretty(sanitizeCause(Cause.fail(outer)));
    expect(chained).toContain('[cause]: Error: hidden form');
    expect(chained).not.toContain('secret-in-message');
  });

  it('renders like the original, reason by reason, and the same when sanitized twice', () => {
    const cause = Cause.fromReasons([
      Cause.makeFailReason(new Error('first')),
      Cause.makeDieReason(new Error('second')),
    ]);
    const once = sanitizeCause(cause);
    expect(once.reasons.map((reason) => reason._tag)).toEqual(['Fail', 'Die']);
    expect(Cause.pretty(once)).toBe(Cause.pretty(cause));
    expect(Cause.pretty(sanitizeCause(once))).toBe(Cause.pretty(once));
    const [first] = Cause.prettyErrors(sanitizeCause(Cause.fail(new Error('x Bearer t1'))));
    expect(first?.message).toBe('x Bearer <redacted>');
  });

  it('masks credentials in span names that the rendered cause prints as stack frames', async () => {
    const exit = await Effect.runPromiseExit(
      Effect.fail(new BoomError()).pipe(
        Effect.withSpan('GET https://user:span-secret@api.example/x?token=span-token'),
      ),
    );
    if (Exit.isSuccess(exit)) {
      throw new Error('expected a failure');
    }

    const raw = Cause.pretty(exit.cause);
    expect(raw).toContain('span-secret');
    const rendered = Cause.pretty(sanitizeCause(exit.cause));
    expect(rendered).toContain('at GET https://<redacted>@api.example/x?token=<redacted>');
    expect(rendered).not.toContain('span-secret');
    expect(rendered).not.toContain('span-token');
  });

  it('keeps the message after an error class name that contains a sensitive word', () => {
    const error = new Error('jwt expired');
    error.name = 'TokenExpiredError';
    const rendered = Cause.pretty(sanitizeCause(Cause.fail(error)));
    expect(rendered).toContain('TokenExpiredError: jwt expired');
  });

  it('never throws on a value it cannot read', () => {
    const revoked = Proxy.revocable({}, {});
    revoked.revoke();
    const rendered = Cause.pretty(sanitizeCause(Cause.fail(revoked.proxy)));
    expect(rendered).toContain('[Unserializable]');
  });

  it('redacts an Error whose message is an object like a field', () => {
    const error = Object.assign(new Error(), { message: { password: 'object-message-pw' } });
    const rendered = Cause.pretty(sanitizeCause(Cause.fail(error)));
    expect(rendered).not.toContain('object-message-pw');
    expect(rendered).toContain('"password":"<redacted>"');
  });

  it('keeps the stack and drops own properties of an Error without a message', () => {
    const error = Object.assign(new Error('placeholder'), {
      message: undefined,
      response: { email: 'customer@example.com' },
    });
    const rendered = Cause.pretty(sanitizeCause(Cause.fail(error)));
    expect(rendered).not.toContain('customer@example.com');
    expect(rendered).toContain('redact.test.ts');
  });

  it('scrubs a credential URL in an Error name on every later rendering', () => {
    const error = new Error('boom');
    error.name = 'FetchError postgres://u:name-pw@db/x';
    const rendered = Cause.pretty(sanitizeCause(Cause.fail(error)));
    expect(rendered).not.toContain('name-pw');
    expect(rendered).toContain('FetchError postgres://<redacted>@db/x');
  });

  it('redacts non-Error values and keeps interrupts and empty causes', () => {
    const rendered = Cause.pretty(
      sanitizeCause(Cause.fail({ password: 'hunter2', email: 'person@example.test' })),
    );
    expect(rendered).not.toContain('hunter2');
    expect(rendered).toContain('person@example.test');

    const interrupt = Cause.interrupt(1);
    expect(sanitizeCause(interrupt).reasons).toEqual(interrupt.reasons);
    expect(Cause.pretty(sanitizeCause(interrupt))).toBe(Cause.pretty(interrupt));
    expect(sanitizeCause(Cause.empty)).toBe(Cause.empty);
  });
});

describe('overrideFiberRefs', () => {
  it('overrides one reference and delegates the rest to the real fiber', async () => {
    const result = await Effect.runPromise(
      Effect.withFiber((fiber) => {
        const proxy = overrideFiberRefs(
          fiber,
          Context.make(References.CurrentLogAnnotations, { replaced: true }),
        );
        return Effect.succeed({
          annotations: proxy.getRef(References.CurrentLogAnnotations),
          contextAnnotations: Context.get(proxy.context, References.CurrentLogAnnotations),
          contextLevel: Context.get(proxy.context, References.MinimumLogLevel),
          level: proxy.getRef(References.MinimumLogLevel),
          sameId: proxy.id === fiber.id,
          fiberAnnotations: fiber.getRef(References.CurrentLogAnnotations),
        });
      }).pipe(Effect.annotateLogs({ original: true })),
    );
    expect(result).toEqual({
      annotations: { replaced: true },
      contextAnnotations: { replaced: true },
      contextLevel: 'Info',
      level: 'Info',
      sameId: true,
      fiberAnnotations: { original: true },
    });
  });
});

/**
 * Service provided next to the redacted annotations, to check that the rest of the context is kept.
 */
class Marker extends Context.Service<Marker, string>()('test/Marker') {}

describe('withRedaction', () => {
  it('redacts annotations and span labels read through fiber.context', async () => {
    const seen: Array<unknown> = [];
    const reader = Logger.make<unknown, void>(({ fiber }) => {
      const descriptor = Object.getOwnPropertyDescriptor(fiber, 'context');
      seen.push({
        annotations: Context.get(fiber.context, References.CurrentLogAnnotations),
        spans: Context.get(fiber.context, References.CurrentLogSpans).map(([label]) => label),
        marker: fiber.context.mapUnsafe.get(Marker.key),
        descriptor: descriptor?.value === fiber.context ? 'same' : 'different',
      });
    });
    const after = await Effect.runPromise(
      Effect.gen(function* () {
        yield* Effect.log('line');
        return yield* Effect.withFiber((fiber) =>
          Effect.succeed(fiber.getRef(References.CurrentLogAnnotations)),
        );
      }).pipe(
        Effect.withLogSpan('GET /cb?token=span-secret'),
        Effect.annotateLogs({ password: 'PWSECRET' }),
        Effect.provide(Logger.layer([withRedaction(reader)])),
        Effect.provideService(Marker, 'kept'),
      ),
    );

    expect(seen).toEqual([
      {
        annotations: { password: '<redacted>' },
        spans: ['GET /cb?token=<redacted>'],
        marker: 'kept',
        descriptor: 'same',
      },
    ]);
    expect(after).toEqual({ password: 'PWSECRET' });
  });
});

describe('withTracerRedaction', () => {
  it('keeps the traced operation running when event attribute keys cannot be listed', async () => {
    const spans: Array<Tracer.NativeSpan> = [];
    const tracer = withTracerRedaction(
      Tracer.make({
        span: (options) => {
          const span = new Tracer.NativeSpan(options);
          spans.push(span);
          return span;
        },
      }),
    );
    const attributes = new Proxy(
      {},
      {
        ownKeys: () => {
          throw new Error('attributes unavailable');
        },
      },
    );
    await Effect.runPromise(
      Effect.gen(function* () {
        const span = yield* Effect.currentSpan;
        span.event('evt', 0n, attributes);
      }).pipe(Effect.withSpan('op'), Effect.withTracer(tracer)),
    );
    expect(spans[0]?.events[0]?.[2]).toEqual({});
  });

  it('honours the redacted names of Effect Headers passed as event and link attributes', async () => {
    const spans: Array<Tracer.NativeSpan> = [];
    const tracer = withTracerRedaction(
      Tracer.make({
        span: (options) => {
          const span = new Tracer.NativeSpan(options);
          spans.push(span);
          return span;
        },
      }),
    );
    const headers = Headers.fromInput({ 'x-tenant': 'TENANT-SECRET', accept: 'json' });
    await Effect.runPromise(
      Effect.gen(function* () {
        const span = yield* Effect.currentSpan;
        span.event('evt', 0n, headers);
        span.addLinks([{ span, attributes: headers }]);
      }).pipe(
        Effect.withSpan('op'),
        Effect.withTracer(tracer),
        Effect.provideService(Headers.CurrentRedactedNames, ['x-tenant']),
      ),
    );
    const span = spans[0];
    const expected = '{"x-tenant":"<redacted>","accept":"json"}';
    expect(JSON.stringify(span?.events[0]?.[2])).toBe(expected);
    expect(JSON.stringify(span?.links[0]?.attributes)).toBe(expected);
  });

  it('keeps the first 1,000 event attributes and marks the rest', async () => {
    const spans: Array<Tracer.NativeSpan> = [];
    const tracer = withTracerRedaction(
      Tracer.make({
        span: (options) => {
          const span = new Tracer.NativeSpan(options);
          spans.push(span);
          return span;
        },
      }),
    );
    const wide = Object.fromEntries(
      Array.from({ length: 1001 }, (_, index) => [`a${index}`, index]),
    );
    await Effect.runPromise(
      Effect.gen(function* () {
        const span = yield* Effect.currentSpan;
        span.event('evt', 0n, wide);
      }).pipe(Effect.withSpan('op'), Effect.withTracer(tracer)),
    );
    const attributes = spans[0]?.events[0]?.[2] ?? {};
    expect(Object.keys(attributes)).toHaveLength(1001);
    expect(attributes['[more]']).toBe('[1 more entries]');
  });
});

describe('guardLogger', () => {
  it('writes the string parts alone when a logger throws, and keeps the fiber alive', async () => {
    const seen: Array<{ readonly message: unknown; readonly annotations: unknown }> = [];
    const others: Array<unknown> = [];
    let calls = 0;
    const flaky = Logger.make((options) => {
      calls += 1;
      if (calls === 1) {
        throw new Error('cannot write this line');
      }

      seen.push({
        message: options.message,
        annotations: options.fiber.getRef(References.CurrentLogAnnotations),
      });
    });
    const broken = Logger.make(() => {
      throw new Error('never writes');
    });
    const other = Logger.make((options) => {
      others.push(options.message);
    });
    const exit = await Effect.runPromiseExit(
      Effect.logError('event.name', { detail: 1 }, Cause.fail('reason')).pipe(
        Effect.annotateLogs({ requestId: 'r1' }),
        Effect.provide(Logger.layer([flaky, broken, other].map(guardLogger))),
      ),
    );
    expect(Exit.isSuccess(exit)).toBe(true);
    expect(seen).toEqual([{ message: ['event.name', '[Unserializable]'], annotations: {} }]);
    expect(others).toHaveLength(1);
  });
});
