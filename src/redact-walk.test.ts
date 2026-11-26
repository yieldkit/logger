import { Cause, Effect, Logger, Redactable, Redacted, Schema } from 'effect';
import { describe, expect, it } from 'vite-plus/test';

import { compactLogFields } from './context.ts';
import { REDACTED_LOG_VALUE } from './credentials.ts';
import { extractErrorFields } from './error.ts';
import { makeJsonLogger } from './formatters.ts';
import { makeLogRedaction, redactLogValue, sanitizeCause } from './redact.ts';

/**
 * Decodes a JSON object.
 */
const decodeRecord = Schema.decodeUnknownSync(
  Schema.fromJsonString(Schema.Record(Schema.String, Schema.Unknown)),
);

/**
 * Node in the shared-reference graph of the walk budget tests: every node points `width` times at
 * the next one.
 */
interface GraphNode {
  readonly children: ReadonlyArray<GraphNode | number>;
}

/**
 * Builds a chain of `depth` nodes in which each node lists the next one `width` times, so a walk
 * that copies every path visits `width ** depth` nodes.
 */
const sharedGraph = (width: number, depth: number): GraphNode => {
  let node: GraphNode = { children: [0] };
  for (let level = 0; level < depth; level += 1) {
    const child: GraphNode = node;
    node = { children: Array.from({ length: width }, (): GraphNode => child) };
  }

  return node;
};

/**
 * A value that keeps a secret and logs only `shown` (Effect's `Redactable` protocol).
 */
class Secretive<A> {
  readonly secret: string;
  readonly shown: A;

  constructor(secret: string, shown: A) {
    this.secret = secret;
    this.shown = shown;
  }

  [Redactable.symbolRedactable](): A {
    return this.shown;
  }
}

describe('key rule', () => {
  it('keeps numbers and booleans under built-in names and masks every other value whole', () => {
    expect(
      redactLogValue({
        usage: { tokenCount: 1200, sessionActive: true, token_limit: 0 },
        tokens: { input: 10, output: 20 },
        tokenType: 'bearer',
        expiresIn: 3600,
        session: new Map([['id', 1]]),
        cookie: new Set(['a']),
        password: null,
      }),
    ).toEqual({
      usage: { tokenCount: 1200, sessionActive: true, token_limit: 0 },
      tokens: REDACTED_LOG_VALUE,
      tokenType: REDACTED_LOG_VALUE,
      expiresIn: 3600,
      session: REDACTED_LOG_VALUE,
      cookie: REDACTED_LOG_VALUE,
      password: null,
    });
  });

  it('masks numbers under configured keys and walks allowed keys by their content', () => {
    const redaction = makeLogRedaction({
      sensitiveKeys: ['accountNumber'],
      allowKeys: ['tokenType', 'tokens'],
    });
    expect(
      redaction.redactValue({
        account_number: 12_345_678,
        tokenType: 'bearer',
        tokens: { input: 10, refreshToken: 'r1', url: 'https://u:p@h/x' },
      }),
    ).toEqual({
      account_number: REDACTED_LOG_VALUE,
      tokenType: 'bearer',
      tokens: { input: 10, refreshToken: REDACTED_LOG_VALUE, url: 'https://<redacted>@h/x' },
    });
  });

  it('writes keys as they are and reads lists item by item', () => {
    expect(redactLogValue({ list: ['password', 'reset'], nested: [{ token: 't' }] })).toEqual({
      list: ['password', 'reset'],
      nested: [{ token: REDACTED_LOG_VALUE }],
    });
  });
});

describe('Redactable values', () => {
  it('is replaced by its redacted form, unwrapped up to three layers', () => {
    const layered = new Secretive('s1', new Secretive('s2', new Secretive('s3', { ok: 1 })));
    expect(redactLogValue({ layered })).toEqual({ layered: { ok: 1 } });
    const deep = new Secretive(
      's1',
      new Secretive('s2', new Secretive('s3', new Secretive('s4', 'x'))),
    );
    expect(redactLogValue({ deep })).toEqual({ deep: '[Truncated]' });
  });

  it('is unwrapped by the same rule in causes, error summaries and log fields', () => {
    const hidden = new Secretive('s1', new Error('shown message'));
    const tooDeep = new Secretive(
      's1',
      new Secretive('s2', new Secretive('s3', new Secretive('s4', 'x'))),
    );
    expect(extractErrorFields(hidden).errorMessage).toBe('shown message');
    expect(extractErrorFields(tooDeep).errorMessage).toBe('[Truncated]');
    expect(Cause.pretty(sanitizeCause(Cause.fail(hidden)))).toContain('Error: shown message');
    expect(Cause.pretty(sanitizeCause(Cause.fail(tooDeep)))).toContain('[Truncated]');
    expect(
      compactLogFields({ secret: 's1', [Redactable.symbolRedactable]: () => ({ visible: 1 }) }),
    ).toEqual({ visible: 1 });
  });

  it('becomes [Unserializable] when its redacted form throws', () => {
    const throwing = {
      [Redactable.symbolRedactable]: (): never => {
        throw new Error('no');
      },
    };
    expect(redactLogValue({ throwing })).toEqual({ throwing: '[Unserializable]' });
  });
});

describe('Error values', () => {
  it('omits an enumerable Error stack from log fields', () => {
    const error = new Error('ordinary');
    Object.defineProperty(error, 'stack', { enumerable: true, value: 'Error: ordinary' });

    expect(redactLogValue(error)).toEqual({ name: 'Error', message: 'ordinary' });
  });
});

describe('walk budget', () => {
  it('summarizes binary data instead of copying it byte by byte', () => {
    const started = performance.now();
    const redacted = redactLogValue({
      body: new Uint8Array(4 * 1024 * 1024),
      view: new DataView(new ArrayBuffer(8)),
      buffer: new ArrayBuffer(16),
    });
    expect(performance.now() - started).toBeLessThan(100);
    expect(redacted).toEqual({
      body: '[Uint8Array 4194304 bytes]',
      view: '[DataView 8 bytes]',
      buffer: '[ArrayBuffer 16 bytes]',
    });
  });

  it('bounds the work for a graph of shared references', () => {
    const started = performance.now();
    const json = JSON.stringify(redactLogValue(sharedGraph(6, 8)));
    expect(performance.now() - started).toBeLessThan(500);
    expect(json.length).toBeLessThan(1_000_000);
    expect(json).toContain('[Truncated]');
  });

  it('stops copying a wide graph of shared records where the budget runs out', () => {
    const leaf = Object.fromEntries(
      Array.from({ length: 1000 }, (_, index) => [`n${String(index)}`, index]),
    );
    const root = Object.fromEntries(
      Array.from({ length: 20 }, (_, index) => [`k${String(index)}`, leaf]),
    );
    const json = JSON.stringify(redactLogValue(root));
    expect(Object.keys(decodeRecord(json))).toEqual([
      ...Array.from({ length: 10 }, (_, index) => `k${String(index)}`),
      '[more]',
    ]);
    expect(json).toMatch(/"n988":988,"\[more\]":"\[Truncated\]"},"\[more\]":"\[Truncated\]"}$/);
  });

  it('counts masked entries against the budget and stops copying where it runs out', () => {
    const leaf = Object.fromEntries(
      Array.from({ length: 1000 }, (_, index) => [`password${String(index)}`, 'x']),
    );
    const root = Object.fromEntries(
      Array.from({ length: 20 }, (_, index) => [`k${String(index)}`, leaf]),
    );
    const json = JSON.stringify(redactLogValue(root));
    expect(Object.keys(decodeRecord(json))).toEqual([
      ...Array.from({ length: 10 }, (_, index) => `k${String(index)}`),
      '[more]',
    ]);
    expect(json.split(REDACTED_LOG_VALUE)).toHaveLength(9 * 1000 + 989 + 1);
    expect(json).toMatch(
      /"password988":"<redacted>","\[more\]":"\[Truncated\]"},"\[more\]":"\[Truncated\]"}$/,
    );
  });

  it('caps the entries copied from one large array, Set, Map or object', () => {
    const many = Array.from({ length: 5000 }, (_, index) => index);
    const redacted = redactLogValue({
      list: many,
      set: new Set(many),
      map: new Map(many.map((index) => [`k${String(index)}`, index])),
      record: Object.fromEntries(many.map((index) => [`k${String(index)}`, index])),
    });
    const json = JSON.stringify(redacted);
    expect(json).toContain('[4000 more items]');
    expect(json).toContain('[4000 more entries]');
    expect(json.length).toBeLessThan(100_000);
  });
});

/**
 * Built-in sensitive names used by the fuzz test.
 */
const FUZZ_SENSITIVE_KEYS = ['password', 'apiKey', 'client_secret', 'X-Auth-Token', 'sessionId'];

/**
 * Plain names used by the fuzz test.
 */
const FUZZ_PLAIN_KEYS = ['id', 'name', 'items', 'meta', 'url'];

/**
 * A value the fuzz test logs.
 */
type FuzzValue =
  | string
  | number
  | Redacted.Redacted
  | Secretive<FuzzValue>
  | ReadonlyArray<FuzzValue>
  | ReadonlySet<FuzzValue>
  | ReadonlyMap<string, FuzzValue>
  | { readonly [key: string]: FuzzValue };

/**
 * Builds random values for the guaranteed tier from a seeded generator: secrets (strings starting
 * with `SECRET_`) appear only inside `Redacted`, inside a `Redactable` value's hidden state, or
 * anywhere below a sensitive key, across records, arrays, `Map`s and `Set`s.
 */
const makeFuzzer = (seed: number) => {
  let state = seed;
  let counter = 0;
  const next = (): number => {
    state = (state * 1_103_515_245 + 12_345) % 2_147_483_648;
    return state / 2_147_483_648;
  };
  const pick = <A>(items: ReadonlyArray<A>, fallback: A): A =>
    items[Math.floor(next() * items.length)] ?? fallback;
  const secret = (): string => {
    counter += 1;
    return `SECRET_${String(counter)}`;
  };

  /**
   * A value that may hold secrets (`withSecrets`) or must not show one.
   */
  const value = (depth: number, withSecrets: boolean): FuzzValue => {
    const roll = Math.floor(next() * (depth > 4 ? 3 : 9));
    switch (roll) {
      case 0:
        return withSecrets ? secret() : `plain ${String(depth)}`;
      case 1:
        return Math.floor(next() * 100);
      case 2:
        return Redacted.make(secret());
      case 3:
        return new Secretive(secret(), value(depth + 1, false));
      case 4:
        return Array.from({ length: 3 }, () => value(depth + 1, withSecrets));
      case 5:
        return new Set([value(depth + 1, withSecrets), value(depth + 1, withSecrets)]);
      case 6:
        return new Map([
          [pick(FUZZ_PLAIN_KEYS, 'id'), value(depth + 1, withSecrets)],
          [pick(FUZZ_SENSITIVE_KEYS, 'password'), value(depth + 1, true)],
        ]);
      default:
        return Object.fromEntries([
          [pick(FUZZ_PLAIN_KEYS, 'id'), value(depth + 1, withSecrets)],
          [pick(FUZZ_SENSITIVE_KEYS, 'password'), value(depth + 1, true)],
          [`${pick(FUZZ_PLAIN_KEYS, 'id')}2`, value(depth + 1, withSecrets)],
        ]);
    }
  };
  return { value };
};

describe('guaranteed tier fuzz', () => {
  it('never writes a secret through the JSON logger, in fields, messages or causes', () => {
    const lines: Array<string> = [];
    const capture = Logger.map(makeJsonLogger({ maxLineBytes: 1024 * 1024 }), (line) => {
      lines.push(line);
    });
    const fuzzer = makeFuzzer(42);
    for (let round = 0; round < 300; round += 1) {
      const payload = fuzzer.value(0, false);
      Effect.runSync(
        Effect.logError('fuzz', payload, Cause.fail(fuzzer.value(0, false))).pipe(
          Effect.annotateLogs({ payload, password: fuzzer.value(0, true) }),
          Effect.provide(Logger.layer([capture])),
        ),
      );
    }

    expect(lines).toHaveLength(300);
    expect(lines.filter((line) => line.includes('SECRET_'))).toEqual([]);
    expect(lines.join('\n')).toContain('<redacted>');
  });
});
