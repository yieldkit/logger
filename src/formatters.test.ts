import {
  Cause,
  Data,
  Effect,
  Exit,
  Layer,
  Logger,
  Redactable,
  Redacted,
  Schema,
  Tracer,
} from 'effect';
import { TestConsole } from 'effect/testing';
import { describe, expect, it } from 'vite-plus/test';

import type { LogFields, LogFormat } from './types.ts';

import { logErrorCause, logFailure, logInfo, withLogContext } from './context.ts';
import { DEFAULT_MAX_LINE_BYTES, makeConsoleLogger, makeJsonLogger } from './formatters.ts';
import { makeLoggerLayer } from './layer.ts';
import { captureLogs } from './testing/index.ts';
import { makeTestLogger } from './testing/index.ts';

/**
 * Tagged error whose `password` field must never be rendered.
 */
class LoginTestError extends Data.TaggedError('LoginTestError')<{
  readonly message: string;
  readonly status: number;
  readonly password: string;
}> {}

/**
 * Tagged upstream failure whose message can be as large as an HTTP error body.
 */
class FeedError extends Data.TaggedError('FeedError')<{
  readonly message: string;
  readonly status: number;
}> {}

/**
 * Secrets the redaction tests log. None of them may appear in any output.
 */
const LEAKED_SECRETS = [
  'abc123',
  'hunter2',
  'tok-777',
  'pw-in-url',
  'sk-live-1',
  'cause-tok-9',
  'wrapped-handle',
];

/**
 * Logs one line that carries every secret in `LEAKED_SECRETS`: in the message, annotations and
 * cause.
 */
const logSecrets = logErrorCause(
  'call failed: Bearer abc123',
  Cause.fail(
    new LoginTestError({
      message: 'login failed: Bearer cause-tok-9',
      status: 401,
      password: 'hunter2',
    }),
  ),
  {
    token: 'tok-777',
    target: 'https://svc:pw-in-url@api.test/x',
    nested: { apiKey: 'sk-live-1', visible: 'kept' },
    handle: Redacted.make('wrapped-handle'),
  },
);

/**
 * Runs `logSecrets` through the console logger for `format` and returns every captured line as
 * text.
 */
const captureFormat = async (format: LogFormat): Promise<string> => {
  const program = Effect.gen(function* () {
    yield* logSecrets;
    const lines = [...(yield* TestConsole.logLines), ...(yield* TestConsole.errorLines)];
    return lines.map((line) => (typeof line === 'string' ? line : JSON.stringify(line))).join('\n');
  }).pipe(
    Effect.provide(
      makeLoggerLayer({ format, colors: false, includeTracerLogger: false }).pipe(
        Layer.provideMerge(TestConsole.layer),
      ),
    ),
  );
  return Effect.runPromise(program);
};

const JsonLogEnvelopeSchema = Schema.Struct({
  timestamp: Schema.String,
  level: Schema.String,
  service: Schema.optional(Schema.String),
  env: Schema.optional(Schema.String),
  version: Schema.optional(Schema.String),
  message: Schema.Unknown,
  fiberId: Schema.String,
  traceId: Schema.optional(Schema.String),
  spanId: Schema.optional(Schema.String),
  annotations: Schema.Record(Schema.String, Schema.Unknown),
  spans: Schema.Record(Schema.String, Schema.Finite),
  cause: Schema.optional(Schema.String),
  error: Schema.optional(Schema.Unknown),
});

const decodeJsonLogLine = Schema.decodeUnknownSync(Schema.fromJsonString(JsonLogEnvelopeSchema));

describe('makeJsonLogger', () => {
  it('writes one JSON line with service metadata, the active span, and a redacted field', async () => {
    const externalSpan = Tracer.externalSpan({
      traceId: 'trace-abc-123',
      spanId: 'span-xyz-789',
    });
    const program = Effect.gen(function* () {
      yield* logInfo('sync.completed', {
        sourceId: 'api:top',
        itemCount: 30,
        ignored: undefined,
        token: Redacted.make('super-secret-token'),
      }).pipe(Effect.provideService(Tracer.ParentSpan, externalSpan));

      return {
        stdout: yield* TestConsole.logLines,
        stderr: yield* TestConsole.errorLines,
      };
    }).pipe(
      Effect.provide(
        makeLoggerLayer({
          service: 'worker',
          env: 'production',
          version: '0.1.0',
          format: 'json',
          stderr: true,
        }).pipe(Layer.provideMerge(TestConsole.layer)),
      ),
    );
    const output = await Effect.runPromise(program);
    expect(output.stdout).toHaveLength(0);
    expect(output.stderr).toHaveLength(1);

    const rawLine = output.stderr[0];
    expect(typeof rawLine).toBe('string');
    expect(String(rawLine)).not.toContain('super-secret-token');

    const parsed = decodeJsonLogLine(rawLine);
    expect(parsed.level).toBe('INFO');
    expect(parsed.service).toBe('worker');
    expect(parsed.env).toBe('production');
    expect(parsed.version).toBe('0.1.0');
    expect(parsed.message).toBe('sync.completed');
    expect(parsed.traceId).toBe('trace-abc-123');
    expect(parsed.spanId).toBe('span-xyz-789');
    expect(parsed.annotations).toEqual({
      sourceId: 'api:top',
      itemCount: 30,
      token: '<redacted>',
    });
  });
});

describe('makeConsoleLogger', () => {
  it('sends every level to stderr when makeConsoleLogger gets stderr true', async () => {
    const formats = ['json', 'logfmt', 'pretty', 'structured'] as const;
    const results = await Promise.all(
      formats.map(async (format) => {
        const logger = makeConsoleLogger({ format, colors: false, stderr: true });
        const program = Effect.gen(function* () {
          yield* Effect.logInfo('line');
          return { stderr: yield* TestConsole.errorLines, stdout: yield* TestConsole.logLines };
        }).pipe(Effect.provide(Logger.layer([logger]).pipe(Layer.provideMerge(TestConsole.layer))));
        const lines = await Effect.runPromise(program);
        return [lines.stderr.length, lines.stdout.length];
      }),
    );
    expect(results).toEqual(formats.map(() => [1, 0]));
  });
});

describe('redaction on console output', () => {
  it('redacts a Bearer token in an Error cause while keeping the error summary', async () => {
    const program = Effect.gen(function* () {
      yield* logFailure('upstream.failed', new Error('call failed: Bearer abc123'));
      return yield* TestConsole.errorLines;
    }).pipe(
      Effect.provide(
        makeLoggerLayer({ format: 'json' }).pipe(Layer.provideMerge(TestConsole.layer)),
      ),
    );
    const [line] = await Effect.runPromise(program);
    expect(String(line)).not.toContain('abc123');

    const parsed = decodeJsonLogLine(line);
    expect(parsed.cause).toContain('call failed: Bearer <redacted>');
    expect(parsed.error).toMatchObject({
      kind: 'fail',
      name: 'Error',
      message: 'call failed: Bearer <redacted>',
    });
  });

  it('drops tagged-error fields from the cause and keeps tag and status', async () => {
    const program = Effect.gen(function* () {
      yield* logSecrets;
      return yield* TestConsole.errorLines;
    }).pipe(
      Effect.provide(
        makeLoggerLayer({ format: 'json' }).pipe(Layer.provideMerge(TestConsole.layer)),
      ),
    );
    const [line] = await Effect.runPromise(program);
    for (const leaked of LEAKED_SECRETS) {
      expect(String(line)).not.toContain(leaked);
    }

    const parsed = decodeJsonLogLine(line);
    expect(parsed.message).toBe('call failed: Bearer <redacted>');
    expect(parsed.cause).toContain('LoginTestError: login failed: Bearer <redacted>');
    expect(parsed.error).toMatchObject({
      kind: 'fail',
      tag: 'LoginTestError',
      status: 401,
      message: 'login failed: Bearer <redacted>',
    });
    expect(parsed.annotations).toMatchObject({
      token: '<redacted>',
      target: 'https://<redacted>@api.test/x',
      nested: { apiKey: '<redacted>', visible: 'kept' },
      handle: '<redacted>',
    });
  });

  it('keeps secrets out of logfmt and pretty output', async () => {
    const outputs = await Promise.all([captureFormat('logfmt'), captureFormat('pretty')]);
    for (const output of outputs) {
      expect(output).toContain('kept');
      expect(output).toContain('login failed: Bearer <redacted>');
      for (const leaked of LEAKED_SECRETS) {
        expect(output).not.toContain(leaked);
      }
    }
  });

  it('masks credentials in log span labels in every format', async () => {
    const effect = logInfo('fetched').pipe(
      Effect.withLogSpan('GET https://u:label-secret@h.example/?token=label-token'),
    );
    const [jsonLine] = await captureJsonLines(effect);
    expect(jsonLine).not.toContain('label-secret');
    expect(jsonLine).not.toContain('label-token');
    expect(jsonLine).toContain('GET https://<redacted>@h.example/?token=<redacted>');

    const logfmt = await Effect.runPromise(
      Effect.gen(function* () {
        yield* effect;
        return yield* TestConsole.logLines;
      }).pipe(
        Effect.provide(
          makeLoggerLayer({ format: 'logfmt' }).pipe(Layer.provideMerge(TestConsole.layer)),
        ),
      ),
    );
    expect(logfmt.join('\n')).not.toContain('label-secret');
  });

  it('applies the layer’s extra key names to the console line and span events', async () => {
    const spans: Array<Tracer.NativeSpan> = [];
    const recordingTracer = Tracer.make({
      span: (options) => {
        const span = new Tracer.NativeSpan(options);
        spans.push(span);
        return span;
      },
    });
    const program = Effect.gen(function* () {
      yield* logInfo('usage', { customerRef: 'cust-1', sessionsActive: 12, sessionState: 'open' });
      return yield* TestConsole.logLines;
    }).pipe(
      Effect.withSpan('op'),
      Effect.provide(
        makeLoggerLayer({
          format: 'json',
          redaction: { sensitiveKeys: ['customerRef'], allowKeys: ['sessionState'] },
        }).pipe(Layer.provideMerge(TestConsole.layer)),
      ),
      Effect.provideService(Tracer.Tracer, recordingTracer),
    );
    const [line] = await Effect.runPromise(program);
    expect(decodeJsonLogLine(line).annotations).toEqual({
      customerRef: '<redacted>',
      sessionsActive: 12,
      sessionState: 'open',
    });
    const events = JSON.stringify(
      spans.flatMap((span) => span.events),
      (_key, value: unknown) => (typeof value === 'bigint' ? value.toString() : value),
    );
    expect(events).not.toContain('cust-1');
    expect(events).toContain('12');
    expect(events).toContain('open');
  });

  it('logs values it cannot read instead of failing the effect', async () => {
    const revoked = Proxy.revocable({}, {});
    revoked.revoke();
    const program = Effect.gen(function* () {
      yield* logFailure('x.failed', Object.create(null));
      yield* logInfo('getter', {
        obj: {
          get broken(): never {
            throw new Error('boom');
          },
        },
      });
      yield* logInfo('map', { m: new Map([[Object.create(null), 1]]), p: revoked.proxy });
      return [...(yield* TestConsole.logLines), ...(yield* TestConsole.errorLines)];
    }).pipe(
      Effect.provide(
        makeLoggerLayer({ format: 'json' }).pipe(Layer.provideMerge(TestConsole.layer)),
      ),
    );
    const exit = await Effect.runPromiseExit(program);
    expect(exit._tag).toBe('Success');
    expect(exit._tag === 'Success' ? exit.value : []).toHaveLength(3);
  });

  it('redacts span events written by the tracer logger', async () => {
    const spans: Array<Tracer.NativeSpan> = [];
    const recordingTracer = Tracer.make({
      span: (options) => {
        const span = new Tracer.NativeSpan(options);
        spans.push(span);
        return span;
      },
    });
    const program = logSecrets.pipe(
      Effect.withSpan('login'),
      Effect.provide(
        makeLoggerLayer({ format: 'json' }).pipe(Layer.provideMerge(TestConsole.layer)),
      ),
      Effect.provideService(Tracer.Tracer, recordingTracer),
    );
    await Effect.runPromise(program);
    const events = spans.flatMap((span) => span.events);
    expect(events).toHaveLength(1);

    const text = JSON.stringify(events, (_key, value: unknown) =>
      typeof value === 'bigint' ? value.toString() : value,
    );
    expect(text).toContain('kept');
    expect(text).toContain('login failed: Bearer <redacted>');
    for (const leaked of LEAKED_SECRETS) {
      expect(text).not.toContain(leaked);
    }
  });
});

/**
 * Lone UTF-16 surrogates, which JSON parsers accept but UTF-8 sinks replace.
 */
const LONE_SURROGATE = /[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/;

/**
 * Smaller cap that keeps the truncation tests fast.
 */
const TEST_MAX_LINE_BYTES = 2048;

/**
 * Decodes one JSON line into a plain record.
 */
const decodeJsonRecord = Schema.decodeUnknownSync(
  Schema.fromJsonString(Schema.Record(Schema.String, Schema.Unknown)),
);

/**
 * Decodes the annotations of one JSON line.
 */
const decodeAnnotations = Schema.decodeUnknownSync(
  Schema.fromJsonString(
    Schema.Struct({ annotations: Schema.Record(Schema.String, Schema.Unknown) }),
  ),
);

/**
 * Builds an Error with a short message and a stack of `length` characters.
 */
const longStackError = (length: number): Error =>
  Object.assign(new Error('boom'), { stack: `Error: boom\n${'e'.repeat(length)}` });

/**
 * Runs `effect` with a JSON logger built from `options` and returns the lines it wrote.
 */
const captureJsonLines = async (
  effect: Effect.Effect<void>,
  options: Parameters<typeof makeJsonLogger>[0] = {},
): Promise<ReadonlyArray<string>> => {
  const lines: Array<string> = [];
  const capture = Logger.map(makeJsonLogger(options), (line) => {
    lines.push(line);
  });
  await Effect.runPromise(effect.pipe(Effect.provide(Logger.layer([capture]))));
  return lines;
};

/**
 * Every string inside a decoded JSON value, keys included.
 */
const decodedStrings = (value: unknown): Array<string> => {
  if (typeof value === 'string') {
    return [value];
  }

  if (Array.isArray(value)) {
    return value.flatMap(decodedStrings);
  }

  if (typeof value === 'object' && value !== null) {
    return Object.entries(value).flatMap(([key, item]) => [key].concat(decodedStrings(item)));
  }

  return [];
};

/**
 * Checks that `line` fits `maxBytes` with its newline and that no decoded string holds a lone
 * surrogate (JSON escapes them as `\udXXX`, so the raw line cannot show one), then decodes it.
 */
const parseWithinCap = (line: string | undefined, maxBytes: number) => {
  const text = line ?? '';
  expect(new TextEncoder().encode(text).byteLength + 1).toBeLessThanOrEqual(maxBytes);
  const record = decodeJsonRecord(text);
  expect(decodedStrings(record).filter((item) => LONE_SURROGATE.test(item))).toEqual([]);
  return record;
};

/**
 * Logs one line with `fields` and returns the JSON line and the structured record.
 */
const logFields = async (fields: LogFields) => {
  const harness = makeTestLogger({ includeTracerLogger: false });
  const lines: Array<string> = [];
  const json = Logger.map(makeJsonLogger(), (line) => {
    lines.push(line);
  });
  await Effect.runPromise(
    logInfo('fields', fields).pipe(Effect.provide(Logger.layer([harness.logger, json]))),
  );
  return { line: lines[0] ?? '', record: harness.records[0] };
};

describe('makeJsonLogger line cap', () => {
  it('leaves a small line unchanged and without a truncated key', async () => {
    const lines = await captureJsonLines(logInfo('small', { a: 1 }));
    const parsed = parseWithinCap(lines[0], DEFAULT_MAX_LINE_BYTES);
    expect(parsed.message).toBe('small');
    expect('truncated' in parsed).toBe(false);
  });

  it('shortens a huge cause and marks the line truncated', async () => {
    const lines = await captureJsonLines(
      logErrorCause('request failed', Cause.die(longStackError(50_000))),
      { maxLineBytes: TEST_MAX_LINE_BYTES },
    );
    expect(lines).toHaveLength(1);

    const parsed = parseWithinCap(lines[0], TEST_MAX_LINE_BYTES);
    expect(parsed.truncated).toBe(true);
    expect(parsed.message).toBe('request failed');
    expect(String(parsed.cause)).toMatch(/ …\[truncated\]$/);
  });

  it('applies the 16 KiB default cap', async () => {
    const lines = await captureJsonLines(
      logErrorCause('request failed', Cause.die(longStackError(100_000))),
    );
    const parsed = parseWithinCap(lines[0], DEFAULT_MAX_LINE_BYTES);
    expect(parsed.truncated).toBe(true);
  });

  it('shortens a huge message when there is no cause', async () => {
    const lines = await captureJsonLines(logInfo('m'.repeat(50_000)), {
      maxLineBytes: TEST_MAX_LINE_BYTES,
    });
    const parsed = parseWithinCap(lines[0], TEST_MAX_LINE_BYTES);
    expect(parsed.truncated).toBe(true);
    expect(String(parsed.message)).toMatch(/^m+ …\[truncated\]$/);
  });

  it('falls back to a minimal record when the annotations alone are too large', async () => {
    const span = Tracer.externalSpan({ traceId: 'trace-1', spanId: 'span-1' });
    const lines = await captureJsonLines(
      logInfo('huge context', { blob: 'y'.repeat(50_000) }).pipe(
        Effect.provideService(Tracer.ParentSpan, span),
      ),
      { maxLineBytes: TEST_MAX_LINE_BYTES, service: 'svc', env: 'test', version: '1.2.3' },
    );
    const parsed = parseWithinCap(lines[0], TEST_MAX_LINE_BYTES);
    expect(parsed).toMatchObject({
      level: 'INFO',
      service: 'svc',
      env: 'test',
      version: '1.2.3',
      traceId: 'trace-1',
      spanId: 'span-1',
      truncated: true,
    });
    expect(String(parsed.message)).toMatch(/^huge context/);
    expect(parsed.annotations).toBeUndefined();
  });

  it('drops identity fields from the minimal record under a very small cap', async () => {
    const span = Tracer.externalSpan({ traceId: 'trace-1', spanId: 'span-1' });
    const identity = { service: 'example-worker-1', env: 'production', version: '1.2.3' };
    const effect = logInfo('small cap', { blob: 'z'.repeat(500) }).pipe(
      Effect.provideService(Tracer.ParentSpan, span),
    );
    const [smallLine] = await captureJsonLines(effect, { ...identity, maxLineBytes: 200 });
    const small = parseWithinCap(smallLine, 200);
    expect(small).toMatchObject({ level: 'INFO', truncated: true, traceId: 'trace-1' });
    expect(small.version).toBeUndefined();

    const [tinyLine] = await captureJsonLines(effect, { ...identity, maxLineBytes: 90 });
    expect(Object.keys(parseWithinCap(tinyLine, 90)).toSorted()).toEqual([
      'level',
      'timestamp',
      'truncated',
    ]);
  });

  it('shortens a huge error message and keeps the error identity', async () => {
    const lines = await captureJsonLines(
      logErrorCause('x', Cause.fail(new FeedError({ message: 'm'.repeat(5000), status: 502 }))),
      { maxLineBytes: 1024 },
    );
    const parsed = parseWithinCap(lines[0], 1024);
    expect(parsed.truncated).toBe(true);
    expect(parsed.message).toBe('x');
    expect(parsed.error).toMatchObject({ kind: 'fail', tag: 'FeedError', status: 502 });
    expect(JSON.stringify(parsed.error)).toMatch(/ …\[truncated\]"/);
  });

  it('keeps the error identity in a minimal record and marks only a cut message', async () => {
    const lines = await captureJsonLines(
      logErrorCause('x', Cause.fail(new FeedError({ message: 'boom', status: 502 }))).pipe(
        Effect.annotateLogs({ blob: 'y'.repeat(5000) }),
      ),
      { maxLineBytes: 1024 },
    );
    const parsed = parseWithinCap(lines[0], 1024);
    expect(parsed).toMatchObject({
      message: 'x',
      truncated: true,
      error: { kind: 'fail', tag: 'FeedError', status: 502 },
    });
    expect(parsed.annotations).toBeUndefined();
  });

  it('keeps the error identity when logFailure annotates a huge message', async () => {
    const lines = await captureJsonLines(
      logFailure('x', new FeedError({ message: 'm'.repeat(5000), status: 502 })),
      { maxLineBytes: 1024 },
    );
    const parsed = parseWithinCap(lines[0], 1024);
    expect(typeof parsed.timestamp).toBe('string');
    expect({ ...parsed, timestamp: undefined }).toEqual({
      timestamp: undefined,
      level: 'ERROR',
      message: 'x',
      truncated: true,
      error: { kind: 'fail', tag: 'FeedError', name: 'FeedError', status: 502 },
    });
  });

  it('keeps emoji and CJK content under the cap without lone surrogates', async () => {
    const cases = ['😀', '日本語', '😀日'].flatMap((unit) => {
      const text = unit.repeat(20_000);
      return [
        logInfo(text),
        logErrorCause('boom', Cause.die(longStackError(0))).pipe(Effect.annotateLogs({ text })),
      ];
    });
    const results = await Promise.all(
      cases.map((effect) => captureJsonLines(effect, { maxLineBytes: TEST_MAX_LINE_BYTES })),
    );
    expect(results).toHaveLength(6);
    for (const lines of results) {
      expect(parseWithinCap(lines[0], TEST_MAX_LINE_BYTES).truncated).toBe(true);
    }
  });

  it('cuts a long emoji cause and a minimal-record message on a surrogate boundary', async () => {
    const sizes = Array.from({ length: 40 }, (_, index) => 600 + index);
    const results = await Promise.all(
      sizes.map((size) =>
        captureJsonLines(logInfo('😀'.repeat(size), { blob: 'y'.repeat(9000) }), {
          maxLineBytes: 1300,
        }),
      ),
    );
    expect(results).toHaveLength(sizes.length);
    for (const lines of results) {
      expect(parseWithinCap(lines[0], 1300).truncated).toBe(true);
    }

    const cause = await captureJsonLines(
      logErrorCause(
        'boom',
        Cause.die(Object.assign(new Error('boom'), { stack: `Error: boom\n${'😀'.repeat(9000)}` })),
      ),
      { maxLineBytes: TEST_MAX_LINE_BYTES },
    );
    expect(parseWithinCap(cause[0], TEST_MAX_LINE_BYTES).truncated).toBe(true);
  });

  it('keeps as much multibyte text as fits instead of cutting it by a byte count', async () => {
    const [line] = await captureJsonLines(logInfo('漢'.repeat(2000)), {
      maxLineBytes: TEST_MAX_LINE_BYTES,
    });
    const record = parseWithinCap(line, TEST_MAX_LINE_BYTES);
    const message = String(record['message']);
    expect(message.endsWith(' …[truncated]')).toBe(true);
    expect(message.startsWith('漢'.repeat(500))).toBe(true);
    expect(new TextEncoder().encode(line).byteLength).toBeGreaterThan(TEST_MAX_LINE_BYTES - 8);
  });

  it('uses the default cap when maxLineBytes is not a finite positive number', async () => {
    const caps = [Number.NaN, 0, -5, Number.POSITIVE_INFINITY];
    const results = await Promise.all(
      caps.map((maxLineBytes) => captureJsonLines(logInfo('hello'), { maxLineBytes })),
    );
    for (const [line] of results) {
      expect(decodeJsonRecord(line ?? '')).toMatchObject({ message: 'hello' });
    }
  });

  it('honors maxLineBytes through makeLoggerLayer', async () => {
    const program = Effect.gen(function* () {
      yield* logInfo('x'.repeat(10_000));
      return yield* TestConsole.logLines;
    }).pipe(
      Effect.provide(
        makeLoggerLayer({ format: 'json', maxLineBytes: 1024 }).pipe(
          Layer.provideMerge(TestConsole.layer),
        ),
      ),
    );
    const [line] = await Effect.runPromise(program);
    expect(parseWithinCap(String(line), 1024).truncated).toBe(true);
  });
});

/**
 * Object that may point back at itself through `self`.
 */
interface SelfReference {
  readonly name: string;
  self?: SelfReference;
}

describe('serialization of unusual annotation values', () => {
  it('renders a circular annotation as [Circular] and stays valid JSON', async () => {
    const loop: SelfReference = { name: 'loop' };
    loop.self = loop;
    const { line, record } = await logFields({ loop });
    const { annotations } = decodeAnnotations(line);
    expect(annotations.loop).toEqual({ name: 'loop', self: '[Circular]' });
    expect(record?.annotations).toEqual(annotations);
  });

  it('does not throw on a BigInt annotation and renders its value', async () => {
    const { line } = await logFields({ count: 10n });
    expect(decodeAnnotations(line).annotations.count).toBe('10n');
  });

  it('renders a nested Error with its cause chain', async () => {
    const root = new RangeError('root failure');
    const { line } = await logFields({
      nested: { error: new TypeError('outer failure', { cause: root }) },
    });
    expect(decodeAnnotations(line).annotations.nested).toMatchObject({
      error: {
        name: 'TypeError',
        message: 'outer failure',
        cause: { name: 'RangeError', message: 'root failure' },
      },
    });
  });

  it('renders a Date as an ISO string', async () => {
    const { line } = await logFields({ at: new Date('2026-01-02T03:04:05.000Z') });
    expect(decodeAnnotations(line).annotations.at).toBe('2026-01-02T03:04:05.000Z');
  });

  it('ignores a serializer attached to a plain Date', async () => {
    const at = Object.assign(new Date('2026-01-02T03:04:05.000Z'), {
      toJSON: () => ({ password: 'date-json-secret' }),
    });
    const { line } = await logFields({ at });
    expect(line).not.toContain('date-json-secret');
    expect(decodeAnnotations(line).annotations.at).toBe('2026-01-02T03:04:05.000Z');
  });

  it('keeps an annotation named toJSON as data', async () => {
    const lines = await captureJsonLines(
      logInfo('annotated').pipe(Effect.annotateLogs({ toJSON: () => null, kept: 1 })),
    );
    expect(decodeAnnotations(lines[0] ?? '').annotations).toEqual({
      toJSON: '[Function]',
      kept: 1,
    });
  });

  it('marks annotations past the item limit with a [more] entry', async () => {
    const many = Object.fromEntries(
      Array.from({ length: 1005 }, (_, index) => [`k${index}`, index]),
    );
    const lines = await captureJsonLines(logInfo('annotated').pipe(Effect.annotateLogs(many)));
    expect(decodeAnnotations(lines[0] ?? '').annotations['[more]']).toBe('[5 more entries]');
  });

  it('renders a Redacted value as <redacted>', async () => {
    const { line } = await logFields({ handle: Redacted.make('hunter2') });
    expect(line).not.toContain('hunter2');
    expect(decodeAnnotations(line).annotations.handle).toBe('<redacted>');
  });
});

/**
 * `Date` subclass whose own conversions throw or reveal a token, as some SDK timestamp classes do.
 */
class HostileDate extends Date {
  override [Symbol.toPrimitive](): never {
    throw new Error('toPrimitive');
  }

  override toJSON(): string {
    return 'date-json-token';
  }
}

/**
 * A callable `Proxy` whose every property and call gives another one, like a tRPC client.
 */
const makeCallableProxy = (): (() => void) =>
  new Proxy(() => undefined, { get: makeCallableProxy, apply: makeCallableProxy });

/**
 * A function whose source text holds a credential.
 */
function handlerWithSecret() {
  return 'Bearer fn-source-secret';
}

/**
 * Field values that used to kill the logging fiber or print a function's source text.
 */
const hostileFields = (): LogFields => {
  const revoked = Proxy.revocable(() => undefined, {});
  revoked.revoke();
  return {
    callable: makeCallableProxy(),
    revoked: revoked.proxy,
    throwingToString: Object.assign(() => 1, {
      toString: () => {
        throw new Error('toString');
      },
    }),
    handler: handlerWithSecret,
    hostileDate: new HostileDate('2026-01-02T03:04:05.000Z'),
    callableRedactable: Object.assign(() => 'callable-redactable-secret', {
      [Redactable.symbolRedactable]: () => 'hidden-callable',
    }),
  };
};

describe('functions and Date subclasses in fields', () => {
  it.each(['json', 'logfmt', 'pretty', 'structured'] as const)(
    'writes the %s line with every field in place and no source text',
    async (format) => {
      const program = Effect.gen(function* () {
        yield* logInfo('hostile', hostileFields());
        yield* logInfo('in.context').pipe(withLogContext(hostileFields()));
        const lines = [...(yield* TestConsole.logLines), ...(yield* TestConsole.errorLines)];
        return lines.map((line) => (typeof line === 'string' ? line : JSON.stringify(line)));
      }).pipe(
        Effect.provide(
          makeLoggerLayer({ format, colors: false, includeTracerLogger: false }).pipe(
            Layer.provideMerge(TestConsole.layer),
          ),
        ),
      );
      const text = (await Effect.runPromise(program)).join('\n');
      expect(text).toContain('in.context');
      expect(text.split('[Function]')).toHaveLength(7);
      expect(text.split('hidden-callable')).toHaveLength(3);
      expect(text.split('2026-01-02')).toHaveLength(3);
      for (const leaked of ['fn-source-secret', 'date-json-token', 'callable-redactable-secret']) {
        expect(text).not.toContain(leaked);
      }
    },
  );

  it('records them with captureLogs', async () => {
    const exit = await Effect.runPromiseExit(captureLogs(logInfo('hostile', hostileFields())));
    expect(Exit.isSuccess(exit)).toBe(true);
    const logs = Exit.isSuccess(exit) ? exit.value.logs : [];
    expect(logs[0]?.annotations).toMatchObject({
      callable: '[Function]',
      revoked: '[Unserializable]',
      throwingToString: '[Function]',
      handler: '[Function]',
      callableRedactable: 'hidden-callable',
    });
    expect(String(logs[0]?.annotations['hostileDate'])).not.toContain('date-json-token');
  });
});
