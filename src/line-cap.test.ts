import {
  Cause,
  Data,
  Duration,
  Effect,
  Formatter,
  Logger,
  Option,
  Redactable,
  Redacted,
} from 'effect';
import { describe, expect, it } from 'vite-plus/test';

import type { ErrorSummary, StructuredLogRecord } from './types.ts';

import { makeJsonLogger, makeStructuredLogger } from './formatters.ts';
import { fitRecord } from './line-cap.ts';
import { omitUndefined } from './omit-undefined.ts';

/**
 * What a shortened field ends with.
 */
const MARKER = ' …[truncated]';

/**
 * Fields the line cap shortens, in order.
 */
const FIELDS = ['cause', 'error.message', 'message'] as const;

/**
 * One field the line cap shortens.
 */
type Field = (typeof FIELDS)[number];

/**
 * Minimal record fields dropped, in order, under a very small cap.
 */
const DROP_ORDER = ['version', 'env', 'service', 'spanId', 'traceId'] as const;

/**
 * The minimal record of the reference implementation.
 */
interface ReferenceMinimal {
  readonly timestamp: string;
  readonly level: string;
  service?: string;
  env?: string;
  version?: string;
  traceId?: string;
  spanId?: string;
  readonly message?: string;
  readonly truncated: true;
  readonly error?: Pick<ErrorSummary, 'kind' | 'tag' | 'name' | 'status'>;
}

/**
 * Reads a shortenable field of the reference implementation.
 */
const read = (current: StructuredLogRecord, field: Field): string | undefined => {
  if (field === 'cause') {
    return current.cause;
  }

  if (field === 'error.message') {
    return current.error?.message;
  }

  return typeof current.message === 'string' ? current.message : undefined;
};

/**
 * Writes a shortenable field of the reference implementation.
 */
const write = (current: StructuredLogRecord, field: Field, text: string): StructuredLogRecord => {
  if (field === 'cause') {
    return { ...current, cause: text };
  }

  if (field === 'error.message') {
    return current.error === undefined
      ? current
      : { ...current, error: { ...current.error, message: text } };
  }

  return { ...current, message: text };
};

/**
 * Cuts text as the reference implementation does, dropping a trailing high surrogate.
 */
const cut = (text: string, keep: number): string => {
  let end = Math.min(keep, text.length);
  const last = end > 0 ? text.charCodeAt(end - 1) : 0;
  if (last >= 0xd8_00 && last <= 0xdb_ff) {
    end -= 1;
  }

  return text.slice(0, end);
};

/**
 * UTF-8 bytes of `text` as JSON string content, quotes excluded.
 */
const jsonBytes = (text: string): number =>
  new TextEncoder().encode(JSON.stringify(text)).length - 2;

/**
 * The line cap as it was before it computed field sizes: every candidate line is serialized and
 * measured, and each field is cut by binary search; a field at most as long as the marker is kept.
 * The tests check the current implementation writes the same bytes.
 */
const referenceFit = (record: StructuredLogRecord, maxBytes: number): string => {
  const fits = (line: string): boolean => new TextEncoder().encode(line).byteLength + 1 <= maxBytes;
  const shorten = (current: StructuredLogRecord, field: Field): StructuredLogRecord => {
    const value = read(current, field);
    if (typeof value !== 'string' || fits(Formatter.formatJson(current))) {
      return current;
    }

    if (jsonBytes(value) <= jsonBytes(MARKER)) {
      return current;
    }

    const withPrefix = (keep: number): StructuredLogRecord =>
      write(current, field, cut(value, keep) + MARKER);
    let low = 0;
    let high = value.length - 1;
    while (low < high) {
      const middle = Math.ceil((low + high) / 2);
      if (fits(Formatter.formatJson(withPrefix(middle)))) {
        low = middle;
      } else {
        high = middle - 1;
      }
    }

    return withPrefix(Math.max(0, low));
  };
  const minimal = (): ReferenceMinimal => {
    const message =
      typeof record.message === 'string' ? record.message : Formatter.formatJson(record.message);
    const units = Math.max(0, Math.floor((maxBytes - 256) / 6));
    const base: ReferenceMinimal = {
      timestamp: record.timestamp,
      level: record.level,
      ...omitUndefined({
        service: record.service,
        env: record.env,
        version: record.version,
        traceId: record.traceId,
        spanId: record.spanId,
      }),
      message: message.length > units ? cut(message, units) + MARKER : message,
      truncated: true,
    };
    if (record.error !== undefined) {
      const { kind, tag, name, status } = record.error;
      const withError = { ...base, error: { kind, ...omitUndefined({ tag, name, status }) } };
      if (fits(Formatter.formatJson(withError))) {
        return withError;
      }
    }

    const candidate = { ...base };
    if (fits(Formatter.formatJson(candidate))) {
      return candidate;
    }

    for (const key of DROP_ORDER) {
      if (key in candidate) {
        delete candidate[key];
        if (fits(Formatter.formatJson(candidate))) {
          return candidate;
        }
      }
    }

    return { timestamp: base.timestamp, level: base.level, truncated: true };
  };

  const line = Formatter.formatJson(record);
  if (fits(line)) {
    return line;
  }

  let fitted: StructuredLogRecord = { ...record, truncated: true };
  for (const field of FIELDS) {
    fitted = shorten(fitted, field);
    const shortened = Formatter.formatJson(fitted);
    if (fits(shortened)) {
      return shortened;
    }
  }

  return Formatter.formatJson(minimal());
};

/**
 * Deterministic pseudo-random numbers in `[0, 1)` (mulberry32), so a failing case can be replayed.
 */
const makeRandom = (seed: number): (() => number) => {
  let state = seed;
  return () => {
    state = (state + 0x6d_2b_79_f5) | 0;
    let mixed = Math.imul(state ^ (state >>> 15), 1 | state);
    mixed = (mixed + Math.imul(mixed ^ (mixed >>> 7), 61 | mixed)) ^ mixed;
    return ((mixed ^ (mixed >>> 14)) >>> 0) / 4_294_967_296;
  };
};

/**
 * Characters whose JSON and UTF-8 sizes differ: plain ASCII, characters JSON escapes, two-, three-
 * and four-byte characters, and lone surrogates (escaped as `\udXXX`).
 */
const PIECES = ['a', 'b', ' ', '"', '\\', '\n', '\u0001', 'é', '€', '😀', '\uD800', '\uDC00', ' '];

describe('JSON line cap', () => {
  it('writes the same line as serializing every candidate, for any field sizes and cap', () => {
    const random = makeRandom(20_261_125);
    const text = (maxLength: number): string => {
      const length = Math.floor(random() * maxLength);
      let built = '';
      for (let index = 0; index < length; index += 1) {
        built += PIECES[Math.floor(random() * PIECES.length)] ?? 'a';
      }

      return built;
    };
    const caps = [90, 150, 300, 600, 1024, 2048, 4096];
    for (let round = 0; round < 600; round += 1) {
      const lengths = [0, 5, 14, 200, 1500, 6000, 20_000];
      const pick = (): number => lengths[Math.floor(random() * lengths.length)] ?? 0;
      const record: StructuredLogRecord = {
        timestamp: '2026-11-25T00:00:00.000Z',
        level: 'ERROR',
        ...omitUndefined({
          service: random() < 0.5 ? 'svc' : undefined,
          env: random() < 0.5 ? 'production' : undefined,
          traceId: random() < 0.5 ? 'a'.repeat(32) : undefined,
        }),
        message: random() < 0.85 ? text(pick()) : { nested: text(pick()) },
        fiberId: '#1',
        annotations: { pad: text(pick()) },
        spans: {},
        ...omitUndefined({
          cause: random() < 0.6 ? text(pick()) : undefined,
          error:
            random() < 0.6
              ? { kind: 'fail' as const, message: text(pick()), tag: 'E', status: 503 }
              : undefined,
        }),
      };
      const maxBytes = caps[Math.floor(random() * caps.length)] ?? 2048;
      expect(fitRecord(record, maxBytes)).toBe(referenceFit(record, maxBytes));
    }
  });
});

/**
 * A class instance with a private field, which the walk copies as a plain record.
 */
class Point {
  readonly x = 1;
  readonly #hidden = 'hidden';

  /**
   * Reads the private field, so it is used.
   */
  hidden(): string {
    return this.#hidden;
  }
}

/**
 * A tagged error carrying a credential field.
 */
class TaggedFailure extends Data.TaggedError('TaggedFailure')<{
  readonly message: string;
  readonly token: string;
}> {}

/**
 * Values of every kind the redaction walk passes through, converts or replaces.
 */
const SERIALIZED_VALUES = {
  text: 'plain',
  number: 1,
  negativeZero: -0,
  notANumber: Number.NaN,
  infinite: Number.POSITIVE_INFINITY,
  flag: true,
  empty: null,
  missing: undefined,
  big: 10n,
  nestedBig: { list: [1n] },
  symbol: Symbol('s'),
  callback: () => 1,
  date: new Date(0),
  redacted: Redacted.make('r-secret'),
  nestedRedacted: { inner: Redacted.make('n-secret'), list: [Redacted.make('l-secret')] },
  list: [1, undefined, () => 1, Symbol('q'), null, [2, [3]]],
  deep: { a: { b: { c: { d: { e: { f: { g: { h: { i: 1 } } } } } } } } },
  point: new Point(),
  withToJson: { toJSON: () => ({ password: 'p', ok: 1 }) },
  error: new Error('m', { cause: new Error('c') }),
  tagged: new TaggedFailure({ message: 'mm', token: 't' }),
  map: new Map<unknown, unknown>([
    ['k', 1],
    [{}, 2],
  ]),
  set: new Set([1, 'a']),
  boxed: [Object(1), Object('ab'), Object(false)],
  nullPrototype: Object.assign(Object.create(null), { a: 1 }),
  getter: {
    get value(): string {
      return 'gv';
    },
  },
  redactable: { [Redactable.symbolRedactable]: () => ({ shown: 'r', password: 'x' }) },
  protoKey: Object.defineProperty({}, '__proto__', { value: { x: 1 }, enumerable: true }),
  option: Option.some(1),
  duration: Duration.seconds(3),
  bytes: new Uint8Array(3),
};

describe('JSON line cap on short fields', () => {
  it('keeps an error message shorter than the truncation marker', async () => {
    const lines: Array<string> = [];
    const json = Logger.map(makeJsonLogger({ maxLineBytes: 300 }), (line) => {
      lines.push(line);
    });
    await Effect.runPromise(
      Effect.logError('m'.repeat(400), Cause.fail(new Error('x'))).pipe(
        Effect.provide(Logger.layer([json])),
      ),
    );
    expect(lines[0]).toContain('"error":{"kind":"fail","message":"x"');
    expect(lines[0]).toContain('"truncated":true');
  });
});

describe('JSON line serialization', () => {
  it('writes the same text as Formatter.formatJson for every kind of value', () => {
    const records: Array<unknown> = [];
    const lines: Array<string> = [];
    const loggers = Logger.layer([
      Logger.map(makeStructuredLogger(), (record) => {
        records.push(record);
      }),
      Logger.map(makeJsonLogger({ maxLineBytes: 1024 * 1024 }), (line) => {
        lines.push(line);
      }),
    ]);
    const logs = Object.entries(SERIALIZED_VALUES).flatMap(([key, value]) => [
      Effect.logInfo('fields').pipe(Effect.annotateLogs({ [key]: value })),
      Effect.logInfo(value),
      Effect.logInfo('message', value),
      Effect.logError('failure', value),
    ]);
    Effect.runSync(
      Effect.all([...logs, Effect.logInfo('all').pipe(Effect.annotateLogs(SERIALIZED_VALUES))], {
        discard: true,
      }).pipe(Effect.provide(loggers)),
    );
    expect(lines).toHaveLength(records.length);
    expect(lines).toEqual(records.map((record) => Formatter.formatJson(record)));
  });
});
