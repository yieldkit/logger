import type { LogLevel } from 'effect';

import { Context, Effect, Layer, Logger, References } from 'effect';

import type { StructuredLogRecord, StructuredLoggerOptions } from '../types.ts';

import { makeStructuredLogger, resolveRedaction } from '../formatters.ts';
import { guardLogger } from '../redact.ts';

/**
 * Options for an in-memory logger. Lines are not written to the console.
 */
export interface TestLoggerOptions extends StructuredLoggerOptions {
  /**
   * Minimum severity captured. Omit to use Effect's default.
   */
  readonly minLevel?: LogLevel.LogLevel | undefined;

  /**
   * When true, also installs the redacted `Logger.tracerLogger`. Defaults to true.
   */
  readonly includeTracerLogger?: boolean | undefined;
}

/**
 * In-memory logger and the records it has captured since the last `clear`.
 */
export interface TestLoggerHarness {
  /**
   * Logger that appends each line to `records`.
   */
  readonly logger: Logger.Logger<unknown, void>;

  /**
   * Layer that installs `logger` and, when set, the minimum level.
   */
  readonly layer: Layer.Layer<never>;

  /**
   * The references `layer` installs (the loggers and, when set, the minimum level), for
   * `Effect.provide` on a single effect without building a layer.
   */
  readonly context: Context.Context<never>;

  /**
   * Lines captured so far, in emit order. Mutated in place.
   */
  readonly records: ReadonlyArray<StructuredLogRecord>;

  /**
   * Removes every captured line. Does not uninstall the layer.
   */
  readonly clear: () => void;
}

/**
 * Builds a logger that stores structured records in memory. The returned array is updated as lines
 * are emitted. Records are redacted exactly like console output, with the built-in sensitive names
 * plus `options.redaction`, and a line that cannot be recorded is handled like in
 * `makeLoggerLayer`.
 */
export const makeTestLogger = (options: TestLoggerOptions = {}): TestLoggerHarness => {
  const entries: Array<StructuredLogRecord> = [];
  const structured = makeStructuredLogger(options);
  const logger = guardLogger(
    Logger.make<unknown, void>((logOptions) => {
      entries.push(structured.log(logOptions));
    }),
  );
  const includeTracerLogger = options.includeTracerLogger ?? true;
  const tracerLogger = guardLogger(
    resolveRedaction(options.redaction).withRedaction(Logger.tracerLogger),
  );
  const loggers = includeTracerLogger ? [logger, tracerLogger] : [logger];
  const withLoggers = Context.make(Logger.CurrentLoggers, new Set(loggers));
  const context =
    options.minLevel !== undefined
      ? Context.add(withLoggers, References.MinimumLogLevel, options.minLevel)
      : withLoggers;
  return {
    logger,
    layer: Layer.succeedContext(context),
    context,
    records: entries,
    clear: () => {
      entries.length = 0;
    },
  };
};

/**
 * Runs `effect` with a fresh in-memory logger and returns the value plus a copy of the lines.
 */
export const captureLogs = <A, E, R>(
  effect: Effect.Effect<A, E, R>,
  options: TestLoggerOptions = {},
): Effect.Effect<{ readonly value: A; readonly logs: ReadonlyArray<StructuredLogRecord> }, E, R> =>
  Effect.suspend(() => {
    const harness = makeTestLogger(options);
    return effect.pipe(
      Effect.provide(harness.context),
      Effect.map((value) => ({
        value,
        logs: [...harness.records],
      })),
    );
  });
