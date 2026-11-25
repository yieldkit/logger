import type { Config, Fiber } from 'effect';

import { Effect, Layer, Logger, References } from 'effect';

import type { LogRedaction } from './redact.ts';
import type { LoggerLayerOptions } from './types.ts';

import { readLoggerConfig, resolveLogFormat } from './config.ts';
import { makeConsoleLogger, resolveRedaction } from './formatters.ts';
import { makeFanOutLogger } from './log-fan-out.ts';
import { defaultLogRedaction, guardLogger } from './redact.ts';

/**
 * Tells whether `Logger.tracerLogger` would add an event for a line logged on `fiber`: the fiber
 * has a current span that is not external and has not ended. This is the check Effect's tracer
 * logger runs before it reads anything else.
 */
const hasRecordingSpan = (fiber: Fiber.Fiber<unknown, unknown>): boolean => {
  const span = fiber.cache.span;
  return span !== undefined && span._tag !== 'ExternalSpan' && span.status._tag !== 'Ended';
};

/**
 * Effect's `Logger.tracerLogger` behind `redaction.withRedaction`. A line logged outside a
 * recording span (see {@link hasRecordingSpan}) is dropped before anything is redacted, since the
 * tracer logger would drop it anyway; inside one, the span event carries the redacted message,
 * annotations and cause.
 */
export const makeRedactedTracerLogger = (redaction: LogRedaction): Logger.Logger<unknown, void> => {
  const redacted = redaction.withRedaction(Logger.tracerLogger);
  return Logger.make((options) => {
    if (hasRecordingSpan(options.fiber)) {
      redacted.log(options);
    }
  });
};

/**
 * Effect's `Logger.tracerLogger` redacted with the built-in sensitive names, so span events (and
 * the traces exported from them) carry the same redacted message, annotations and cause as the
 * console line. Lines logged outside a recording span cost nothing. `makeLoggerLayer` builds its
 * own with the layer's `redaction` option.
 */
export const redactedTracerLogger: Logger.Logger<unknown, void> =
  makeRedactedTracerLogger(defaultLogRedaction);

/**
 * Drops every log line by setting the minimum level to `None`.
 */
export const SilentLoggerLayer: Layer.Layer<never> = Layer.succeed(
  References.MinimumLogLevel,
  'None',
);

/**
 * Installs the console logger from `options`. Does not read the environment. `stderr` of `true` or
 * `false` sets `Logger.LogToStderr`, and `leveled` (the default) routes by level. Includes a
 * redacted `Logger.tracerLogger` unless `includeTracerLogger` is false. Always includes the fan-out
 * logger that forwards each record to the log export sinks `telemetryLayer` provides (the OTLP log
 * exporter). Every one of them redacts with the built-in sensitive names plus `options.redaction`,
 * and none of them can fail the fiber that logs: a line one of them cannot write is retried with
 * only the message's string parts, and dropped when that fails too.
 */
export const makeLoggerLayer = (options: LoggerLayerOptions = {}): Layer.Layer<never> => {
  const format = resolveLogFormat(options.format ?? 'auto', options.env);
  const redaction = resolveRedaction(options.redaction);
  const consoleLogger = makeConsoleLogger({
    format,
    service: options.service,
    env: options.env,
    version: options.version,
    colors: options.colors,
    maxLineBytes: options.maxLineBytes,
    stderr: options.stderr ?? 'leveled',
    redaction: options.redaction,
  });
  const fanOutLogger = makeFanOutLogger(redaction);
  const includeTracerLogger = options.includeTracerLogger ?? true;
  const loggers = includeTracerLogger
    ? [consoleLogger, makeRedactedTracerLogger(redaction), fanOutLogger]
    : [consoleLogger, fanOutLogger];
  const baseLayer = Layer.mergeAll(
    Logger.layer(loggers.map(guardLogger)),
    Layer.succeed(References.MinimumLogLevel, options.minLevel ?? 'Info'),
  );

  if (typeof options.stderr === 'boolean') {
    return Layer.mergeAll(baseLayer, Layer.succeed(Logger.LogToStderr, options.stderr));
  }

  return baseLayer;
};

/**
 * Installs the console logger from `LOG_LEVEL`, `LOG_FORMAT`, `LOG_STDERR`, `LOG_COLORS`, and
 * `NODE_ENV`, falling back to `defaults` (which also carry `service`, `version`, `maxLineBytes`,
 * `includeTracerLogger` and `redaction`). Invalid values fail with `ConfigError` before a line is
 * written.
 */
export const LoggerLive = (
  defaults: LoggerLayerOptions = {},
): Layer.Layer<never, Config.ConfigError> =>
  Layer.unwrap(Effect.map(readLoggerConfig(defaults), makeLoggerLayer));
