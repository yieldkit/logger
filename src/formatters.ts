import type { LogLevel } from 'effect';

import { Console, Context, Logger, Option, Tracer } from 'effect';

import type { RedactionOptions } from './credentials.ts';
import type { LogRedaction } from './redact.ts';
import type {
  LogFormat,
  LogStderrMode,
  StructuredLogRecord,
  StructuredLoggerOptions,
} from './types.ts';

import { summarizeCause } from './error.ts';
import { fitRecord, resolveMaxLineBytes } from './line-cap.ts';
import { omitUndefined } from './omit-undefined.ts';
import { defaultLogRedaction, makeLogRedaction, overrideFiberRefs } from './redact.ts';

export { DEFAULT_MAX_LINE_BYTES } from './line-cap.ts';

/**
 * Levels written to stderr in `leveled` mode.
 */
const STDERR_LEVELS: ReadonlySet<LogLevel.LogLevel> = new Set(['Warn', 'Error', 'Fatal']);

/**
 * Redactions built by {@link resolveRedaction}, by the options object they were built from.
 */
const redactionsByOptions = new WeakMap<RedactionOptions, LogRedaction>();

/**
 * Returns the redaction for `options`: the built-in sensitive names when none are given. The same
 * options object always gives the same redaction, so the console, tracer and fan-out loggers of one
 * layer share its memos and redact each line once between them.
 */
export const resolveRedaction = (options: RedactionOptions | undefined): LogRedaction => {
  if (options === undefined) {
    return defaultLogRedaction;
  }

  const existing = redactionsByOptions.get(options);
  if (existing !== undefined) {
    return existing;
  }

  const created = makeLogRedaction(options);
  redactionsByOptions.set(options, created);
  return created;
};

/**
 * Builds a logger that emits a `StructuredLogRecord`. The message, annotations, log span labels and
 * cause are redacted with the built-in sensitive names plus `options.redaction` (see
 * `redactLogValue` and `sanitizeCause`), and `Redacted` values print as `<redacted>`. The `error`
 * summary is read from the original cause, so its status survives, and its message, tag and name
 * are masked. A parent span adds `traceId` and `spanId`.
 */
export const makeStructuredLogger = (
  options: StructuredLoggerOptions = {},
): Logger.Logger<unknown, StructuredLogRecord> => {
  const redaction = resolveRedaction(options.redaction);
  return Logger.make((logOptions) => {
    const base = Logger.formatStructured.log(redaction.redactLogOptions(logOptions));
    const activeSpan = Option.getOrUndefined(
      Context.getOption(logOptions.fiber.context, Tracer.ParentSpan),
    );
    const error = summarizeCause(logOptions.cause, redaction);
    return {
      timestamp: base.timestamp,
      level: base.level,
      ...omitUndefined({
        service: options.service,
        env: options.env,
        version: options.version,
      }),
      message: base.message,
      fiberId: base.fiberId,
      ...omitUndefined({
        traceId: activeSpan?.traceId,
        spanId: activeSpan?.spanId,
      }),
      annotations: base.annotations,
      spans: base.spans,
      ...omitUndefined({ cause: base.cause, error }),
    };
  });
};

/**
 * Builds a logger that emits one JSON line per record, redacted like `makeStructuredLogger`. A line
 * longer than `maxLineBytes` in UTF-8, newline included, is shortened: `truncated: true` is added,
 * then `cause`, `error.message` and `message` are cut to the longest start that fits, and a record
 * that still does not fit is replaced by a minimal record with the identity fields, trace ids, the
 * error's kind, tag, name and status, and the start of the message. A missing, non-finite or
 * non-positive `maxLineBytes` uses `DEFAULT_MAX_LINE_BYTES`.
 */
export const makeJsonLogger = (
  options: StructuredLoggerOptions = {},
): Logger.Logger<unknown, string> => {
  const maxBytes = resolveMaxLineBytes(options.maxLineBytes);
  return Logger.map(makeStructuredLogger(options), (record) => fitRecord(record, maxBytes));
};

/**
 * Sends formatted output to stderr or stdout. With no `mode`, a line goes to stderr only when
 * `Logger.LogToStderr` is set. `true` always uses stderr. `leveled` also honors `LogToStderr`, and
 * otherwise sends Warn, Error and Fatal to `console.error` and everything else to `console.log`. It
 * never calls `console.trace`, `console.debug` or `console.info`.
 */
export const withConsoleRouting = <Message, Output>(
  logger: Logger.Logger<Message, Output>,
  mode?: LogStderrMode,
): Logger.Logger<Message, void> =>
  Logger.make((logOptions) => {
    const output = logger.log(logOptions);
    const consoleService = logOptions.fiber.getRef(Console.Console);
    const forced = mode === true || logOptions.fiber.getRef(Logger.LogToStderr);
    const leveled = mode === 'leveled' && STDERR_LEVELS.has(logOptions.logLevel);
    if (forced || leveled) {
      consoleService.error(output);
      return;
    }

    consoleService.log(output);
  });

/**
 * Wraps Effect's pretty logger, which picks its stream from `Logger.LogToStderr`, so that the lines
 * `mode` sends to stderr see the ref as true: Warn, Error and Fatal for `leveled`, and every line
 * for `true`. Other modes return `logger` unchanged, so the ref alone decides.
 */
const withPrettyStderr = (
  logger: Logger.Logger<unknown, void>,
  mode: LogStderrMode | undefined,
): Logger.Logger<unknown, void> => {
  if (mode !== true && mode !== 'leveled') {
    return logger;
  }

  return Logger.make((logOptions) => {
    if (mode === 'leveled' && !STDERR_LEVELS.has(logOptions.logLevel)) {
      logger.log(logOptions);
      return;
    }

    const overrides = Context.make(Logger.LogToStderr, true);
    logger.log({ ...logOptions, fiber: overrideFiberRefs(logOptions.fiber, overrides) });
  });
};

/**
 * Options for the console logger. `format` selects the encoder.
 */
export interface ConsoleLoggerOptions extends StructuredLoggerOptions {
  /**
   * Encoder. Pretty uses Effect's console logger and does not add service or trace fields.
   */
  readonly format: LogFormat;

  /**
   * ANSI color mode for the pretty encoder. Ignored by JSON, structured, and logfmt.
   */
  readonly colors?: 'auto' | boolean | undefined;

  /**
   * Stream routing. `leveled` sends Warn, Error and Fatal to stderr and the rest to stdout, and
   * `true` sends every line to stderr. Omit or use `false` to follow `Logger.LogToStderr` only.
   */
  readonly stderr?: LogStderrMode | undefined;
}

/**
 * Builds the console logger for `format`. JSON and structured include service and span ids. Pretty
 * and logfmt use Effect's own formatters behind `withRedaction`. Every format is redacted with the
 * built-in sensitive names plus `options.redaction`.
 */
export const makeConsoleLogger = (options: ConsoleLoggerOptions): Logger.Logger<unknown, void> => {
  switch (options.format) {
    case 'json':
      return withConsoleRouting(makeJsonLogger(options), options.stderr);
    case 'structured':
      return withConsoleRouting(makeStructuredLogger(options), options.stderr);
    case 'logfmt': {
      const redaction = resolveRedaction(options.redaction);
      return withConsoleRouting(redaction.withRedaction(Logger.formatLogFmt), options.stderr);
    }
    case 'pretty': {
      const redaction = resolveRedaction(options.redaction);
      const pretty = Logger.consolePretty({ colors: options.colors ?? 'auto' });
      return redaction.withRedaction(withPrettyStderr(pretty, options.stderr));
    }
    default: {
      const unexpected: never = options.format;
      return unexpected;
    }
  }
};
