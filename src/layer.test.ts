import type { LogLevel } from 'effect';

import { ConfigProvider, Console, Effect, Exit, Layer, Logger, References, Tracer } from 'effect';
import { TestConsole } from 'effect/testing';
import { describe, expect, it } from 'vite-plus/test';

import type { RedactionOptions } from './credentials.ts';
import type { LogFormat, LogStderrMode } from './types.ts';

import { readLoggerConfig } from './config.ts';
import { logInfo } from './context.ts';
import { LoggerLive, SilentLoggerLayer, makeLoggerLayer, redactedTracerLogger } from './layer.ts';
import { logExportSinkLayer } from './log-fan-out.ts';

/**
 * Every severity the routing tests emit, in ascending order.
 */
const LEVELS: ReadonlyArray<LogLevel.Severity> = [
  'Trace',
  'Debug',
  'Info',
  'Warn',
  'Error',
  'Fatal',
];

/**
 * Console methods a mock records, so a test can see which one a line used.
 */
type Method = 'log' | 'error' | 'trace' | 'debug' | 'info' | 'warn';

/**
 * Builds a console that appends the method name to `calls` and swallows grouping calls.
 */
const makeMockConsole = (calls: Array<Method>): Console.Console => {
  const record =
    (method: Method) =>
    (..._args: ReadonlyArray<unknown>): void => {
      calls.push(method);
    };
  return {
    ...console,
    log: record('log'),
    error: record('error'),
    trace: record('trace'),
    debug: record('debug'),
    info: record('info'),
    warn: record('warn'),
    group: () => undefined,
    groupCollapsed: () => undefined,
    groupEnd: () => undefined,
  };
};

/**
 * Logs one line at `level` through a logger built from `format` and `stderr`, and returns the
 * console methods it used.
 */
const routeLevel = async (
  level: LogLevel.Severity,
  format: LogFormat,
  stderr?: LogStderrMode,
): Promise<ReadonlyArray<Method>> => {
  const calls: Array<Method> = [];
  const program = Effect.logWithLevel(level)('line').pipe(
    Effect.provide(makeLoggerLayer({ format, colors: false, minLevel: 'All', stderr })),
    Effect.provideService(Console.Console, makeMockConsole(calls)),
  );
  await Effect.runPromise(program);
  return calls;
};

/**
 * Logs one line per level and returns the single console method each line used, keyed by level.
 */
const routeLevels = async (
  format: LogFormat,
  stderr?: LogStderrMode,
): Promise<Record<string, Method | undefined>> => {
  const results = await Promise.all(LEVELS.map((level) => routeLevel(level, format, stderr)));
  for (const calls of results) {
    expect(calls).toHaveLength(1);
  }

  return Object.fromEntries(LEVELS.map((level, index) => [level, results[index]?.[0]]));
};

/**
 * Resolves the config from `env`, builds the layer and returns the console method used for one line
 * at `level`.
 */
const routeFromEnv = async (
  env: Record<string, string>,
  level: LogLevel.Severity,
): Promise<Method | undefined> => {
  const calls: Array<Method> = [];
  const program = Effect.gen(function* () {
    const resolved = yield* readLoggerConfig({ format: 'json' });
    return yield* Effect.logWithLevel(level)('line').pipe(
      Effect.provide(makeLoggerLayer({ ...resolved, colors: false })),
    );
  }).pipe(
    Effect.provide(Layer.succeed(ConfigProvider.ConfigProvider, ConfigProvider.fromEnv({ env }))),
    Effect.provideService(Console.Console, makeMockConsole(calls)),
  );
  await Effect.runPromise(program);
  return calls[0];
};

/**
 * Expected routing in `leveled` mode.
 */
const LEVELED_ROUTING = {
  Trace: 'log',
  Debug: 'log',
  Info: 'log',
  Warn: 'error',
  Error: 'error',
  Fatal: 'error',
};

describe('LoggerLive', () => {
  it('installs a redacted tracer logger, never the raw one, beside the console logger', async () => {
    const hasTracer = await Effect.runPromise(
      Effect.service(Logger.CurrentLoggers).pipe(
        Effect.map((loggers) => loggers.size === 3 && !loggers.has(Logger.tracerLogger)),
        Effect.provide(
          LoggerLive({ service: 'api', format: 'json' }).pipe(
            Layer.provide(ConfigProvider.layer(ConfigProvider.fromEnv({ env: {} }))),
          ),
        ),
      ),
    );
    expect(hasTracer).toBe(true);
  });
});

describe('SilentLoggerLayer', () => {
  it('drops every line even when a console logger is installed', async () => {
    const silentOutput = await Effect.runPromise(
      Effect.gen(function* () {
        yield* logInfo('should-not-emit');
        return yield* TestConsole.logLines;
      }).pipe(
        Effect.provide(
          SilentLoggerLayer.pipe(
            Layer.provideMerge(
              makeLoggerLayer({ format: 'json' }).pipe(Layer.provideMerge(TestConsole.layer)),
            ),
          ),
        ),
      ),
    );
    expect(silentOutput).toHaveLength(0);
  });
});

describe('makeLoggerLayer stderr routing', () => {
  for (const format of ['json', 'logfmt', 'pretty', 'structured'] as const) {
    it(`sends Warn and above to console.error and the rest to console.log in ${format}`, async () => {
      expect(await routeLevels(format)).toEqual(LEVELED_ROUTING);
      expect(await routeLevels(format, 'leveled')).toEqual(LEVELED_ROUTING);
    });
  }

  it('sends every level to stderr when stderr is true', async () => {
    const routed = await routeLevels('json', true);
    expect(Object.values(routed).every((method) => method === 'error')).toBe(true);
  });

  it('sends every level to stdout when stderr is false', async () => {
    const results = await Promise.all([routeLevels('json', false), routeLevels('pretty', false)]);
    for (const routed of results) {
      expect(Object.values(routed).every((method) => method === 'log')).toBe(true);
    }
  });
});

describe('makeLoggerLayer with LOG_STDERR from the environment', () => {
  it('sends Info to stderr when LOG_STDERR is true', async () => {
    expect(await routeFromEnv({ LOG_STDERR: 'true' }, 'Info')).toBe('error');
  });

  it('sends Error to stdout when LOG_STDERR is false', async () => {
    expect(await routeFromEnv({ LOG_STDERR: 'false' }, 'Error')).toBe('log');
  });

  it('routes by level when LOG_STDERR is leveled or unset', async () => {
    expect(await routeFromEnv({ LOG_STDERR: 'LEVELED' }, 'Error')).toBe('error');
    expect(await routeFromEnv({ LOG_STDERR: 'leveled' }, 'Info')).toBe('log');
    expect(await routeFromEnv({}, 'Warn')).toBe('error');
    expect(await routeFromEnv({}, 'Info')).toBe('log');
  });
});

/**
 * Tracer that keeps every span it builds in `spans`, so a test can read their events.
 */
const makeRecordingTracer = (spans: Array<Tracer.NativeSpan>): Tracer.Tracer =>
  Tracer.make({
    span: (options) => {
      const span = new Tracer.NativeSpan(options);
      spans.push(span);
      return span;
    },
  });

/**
 * Serializes span events, writing bigint timestamps as strings.
 */
const eventsText = (spans: ReadonlyArray<Tracer.NativeSpan>): string =>
  JSON.stringify(
    spans.flatMap((span) => span.events),
    (_key, value: unknown) => (typeof value === 'bigint' ? value.toString() : value),
  );

/**
 * Logs one line whose fields count how often they are read, through the redacted tracer logger
 * alone, inside a span when `inSpan` is set. Returns the reads and the span events written.
 */
const logCountingReads = async (
  inSpan: boolean,
): Promise<{ readonly reads: number; readonly events: string }> => {
  let reads = 0;
  const fields = {
    get password(): string {
      reads += 1;
      return 'hunter2';
    },
  };
  const spans: Array<Tracer.NativeSpan> = [];
  const line = Effect.logInfo('line').pipe(Effect.annotateLogs({ fields }));
  await Effect.runPromise(
    (inSpan ? Effect.withSpan(line, 'op') : line).pipe(
      Effect.provide(Logger.layer([redactedTracerLogger])),
      Effect.provideService(Tracer.Tracer, makeRecordingTracer(spans)),
    ),
  );
  return { reads, events: eventsText(spans) };
};

describe('redactedTracerLogger', () => {
  it('reads nothing for a line logged outside a span', async () => {
    expect((await logCountingReads(false)).reads).toBe(0);
  });

  it('redacts the event of a line logged inside a span', async () => {
    const { reads, events } = await logCountingReads(true);
    expect(reads).toBe(1);
    expect(events).toContain('<redacted>');
    expect(events).not.toContain('hunter2');
  });
});

/**
 * Logs one line per item of `values` inside a span through the console, tracer and fan-out loggers
 * (with one sink). The line's field counts its reads and returns `values` in turn. Returns the
 * reads, the console lines and what the sink saw.
 */
const logThroughEveryLogger = async (
  redaction: RedactionOptions | undefined,
  values: ReadonlyArray<string>,
) => {
  let reads = 0;
  const fields = {
    get detail(): string {
      const value = values[reads] ?? '';
      reads += 1;
      return value;
    },
  };
  const sunk: Array<unknown> = [];
  const sink = logExportSinkLayer(
    Effect.succeed(
      Logger.make((options) => {
        sunk.push(options.fiber.getRef(References.CurrentLogAnnotations));
      }),
    ),
  );
  const line = Effect.logInfo('line').pipe(Effect.annotateLogs({ fields }), Effect.withSpan('op'));
  const program = Effect.gen(function* () {
    yield* Effect.forEach(values, () => line, { discard: true });
    return yield* TestConsole.logLines;
  }).pipe(
    Effect.provide(
      Layer.mergeAll(makeLoggerLayer({ format: 'json', redaction }), sink).pipe(
        Layer.provideMerge(TestConsole.layer),
      ),
    ),
  );
  const lines = await Effect.runPromise(program);
  return { reads, lines: lines.map(String), sunk: JSON.stringify(sunk) };
};

describe('makeLoggerLayer redaction per line', () => {
  it('redacts a line once for the console, tracer and fan-out loggers together', async () => {
    const results = await Promise.all(
      [undefined, { sensitiveKeys: ['customerRef'] }].map((redaction) =>
        logThroughEveryLogger(redaction, ['first']),
      ),
    );
    for (const { reads, lines, sunk } of results) {
      expect(reads).toBe(1);
      expect(lines[0]).toContain('first');
      expect(sunk).toContain('first');
    }
  });

  it('redacts every line afresh when the same fields object changes between lines', async () => {
    const { reads, lines, sunk } = await logThroughEveryLogger(undefined, ['first', 'second']);
    expect(reads).toBe(2);
    expect(lines[0]).toContain('first');
    expect(lines[1]).toContain('second');
    expect(sunk).toContain('second');
  });
});

describe('makeLoggerLayer guard', () => {
  it('keeps the logging fiber alive when the console throws, and writes the event name', async () => {
    const lines: Array<unknown> = [];
    let calls = 0;
    const throwingOnce: Console.Console = {
      ...console,
      log: (...args: ReadonlyArray<unknown>) => {
        calls += 1;
        if (calls === 1) {
          throw new Error('console rejected the line');
        }

        lines.push(args[0]);
      },
    };
    const exit = await Effect.runPromiseExit(
      Effect.logInfo('event.name').pipe(
        Effect.annotateLogs({ requestId: 'r1' }),
        Effect.provide(makeLoggerLayer({ format: 'json', includeTracerLogger: false })),
        Effect.provideService(Console.Console, throwingOnce),
      ),
    );
    expect(Exit.isSuccess(exit)).toBe(true);
    expect(lines).toHaveLength(1);
    expect(String(lines[0])).toContain('"message":"event.name"');
    expect(String(lines[0])).not.toContain('requestId');
  });
});
