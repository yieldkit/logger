import { Effect, LogLevel, Metric, Queue, References } from 'effect';

import type { LogFields } from './types.ts';

import { compactLogFields, logWarning } from './context.ts';

/**
 * Writes one log line from a plain callback. `fields` become log annotations of the line, and
 * `undefined` values are dropped.
 */
export type CallbackLogFunction = (message: string, fields?: LogFields) => void;

/**
 * Synchronous logging functions for callbacks that run outside any fiber, such as event emitters
 * and library hooks.
 */
export type CallbackLogger = {
  /**
   * Logs at trace level.
   */
  readonly trace: CallbackLogFunction;

  /**
   * Logs at debug level.
   */
  readonly debug: CallbackLogFunction;

  /**
   * Logs at info level.
   */
  readonly info: CallbackLogFunction;

  /**
   * Logs at warning level.
   */
  readonly warn: CallbackLogFunction;

  /**
   * Logs at error level.
   */
  readonly error: CallbackLogFunction;
};

/**
 * Default `CallbackLoggerOptions.capacity`: lines that can wait for the writer fiber at once.
 */
export const CALLBACK_LOGGER_CAPACITY = 1024;

/**
 * Message of the Warn line written once per overflow, when a callback logger starts dropping lines.
 */
const OVERFLOW_MESSAGE = 'logger.callback.overflow';

/**
 * Counter `logger_callback_dropped_total`: lines a callback logger dropped because its queue was
 * full. It is updated by the writer fiber, so it trails the drops by at most one written line, and
 * drops still unreported when the scope closes are added before it finishes closing.
 */
export const callbackLoggerDropped = Metric.counter('logger_callback_dropped_total', {
  description: 'Lines a callback logger dropped because its queue was full.',
  incremental: true,
});

/**
 * Options for `makeCallbackLogger`.
 */
export type CallbackLoggerOptions = {
  /**
   * Lines that can wait for the writer fiber at once. Defaults to `CALLBACK_LOGGER_CAPACITY`
   * (1024); must be an integer >= 1, or `makeCallbackLogger` dies. A line logged while the queue is
   * full is dropped, so a burst never blocks the caller or grows memory without bound.
   */
  readonly capacity?: number | undefined;
};

/**
 * Dies when `capacity` is not an integer >= 1.
 */
const validateCapacity = (capacity: number): Effect.Effect<number> =>
  Number.isInteger(capacity) && capacity >= 1
    ? Effect.succeed(capacity)
    : Effect.die(
        new Error(`callback logger capacity must be an integer >= 1 (got ${String(capacity)})`),
      );

/**
 * Log line queued by a callback logger.
 */
type QueuedLog = {
  /**
   * Level to log at.
   */
  readonly level: LogLevel.Severity;

  /**
   * Log message.
   */
  readonly message: string;

  /**
   * Fields with `undefined` values removed, added as annotations.
   */
  readonly fields: LogFields;
};

/**
 * Creates a `CallbackLogger` whose lines are queued and written by a fiber forked in the current
 * scope, so they go through the Effect loggers with the annotations that were in place when this
 * effect ran, plus the line's own fields. The loggers, minimum level and span of the creating fiber
 * apply too, so lines created under `Effect.withSpan` carry its trace and span ids.
 *
 * Lines below the creating fiber's minimum log level are dropped before they are queued. At most
 * `options.capacity` lines (default `CALLBACK_LOGGER_CAPACITY`) wait for the writer; a line logged
 * while the queue is full is dropped without blocking or throwing. Drops are added to
 * `callbackLoggerDropped`, and the first drop of each overflow (again only after a later line fit)
 * writes one `logger.callback.overflow` Warn line with `capacity` and `droppedTotal`, from the
 * writer fiber. A line that a logger fails on is dropped on its own; later lines are still written.
 * Lines still queued when the scope closes are written, and unreported drops reported, before it
 * finishes closing. The queue is then shut down, even when writing them failed, so a call after
 * that is dropped without throwing and without being counted. Dies when `options.capacity` is not
 * an integer >= 1.
 */
export const makeCallbackLogger = Effect.fnUntraced(function* (
  options: CallbackLoggerOptions = {},
) {
  const capacity = yield* validateCapacity(options.capacity ?? CALLBACK_LOGGER_CAPACITY);
  const queue = yield* Queue.bounded<QueuedLog>(capacity);
  const minimumLevel = yield* References.MinimumLogLevel;
  let closed = false;
  let overflowing = false;
  let unreportedDrops = 0;
  let unreportedOverflow = false;
  let droppedTotal = 0;

  /**
   * Adds the drops since the last report to `callbackLoggerDropped`, and writes the overflow
   * warning when a new overflow started since then. Does nothing when nothing was dropped.
   */
  const reportDrops = Effect.suspend(() => {
    if (unreportedDrops === 0) {
      return Effect.void;
    }

    const count = Metric.update(callbackLoggerDropped, unreportedDrops);
    const warn = unreportedOverflow;
    unreportedDrops = 0;
    unreportedOverflow = false;
    return warn
      ? Effect.andThen(count, logWarning(OVERFLOW_MESSAGE, { capacity, droppedTotal }))
      : count;
  }).pipe(Effect.ignoreCause);

  /**
   * Writes one queued line through the Effect loggers. A failure or defect in a logger is dropped,
   * so one bad line never stops the writer.
   */
  const write = (entry: QueuedLog): Effect.Effect<void> =>
    Effect.logWithLevel(entry.level)(entry.message).pipe(
      Effect.annotateLogs(entry.fields),
      Effect.ignoreCause,
    );
  yield* Queue.take(queue).pipe(
    Effect.flatMap(write),
    Effect.andThen(reportDrops),
    Effect.forever,
    Effect.forkScoped,
  );
  yield* Effect.addFinalizer(() =>
    Queue.clear(queue).pipe(
      Effect.flatMap((entries) => Effect.forEach(entries, write, { discard: true })),
      Effect.andThen(reportDrops),
      Effect.ensuring(
        Effect.suspend(() => {
          closed = true;
          return Queue.shutdown(queue);
        }),
      ),
    ),
  );

  /**
   * Builds the logging function for one level. It never blocks and never throws.
   */
  const at =
    (level: LogLevel.Severity): CallbackLogFunction =>
    (message, fields = {}) => {
      if (closed || LogLevel.isLessThan(level, minimumLevel)) {
        return;
      }

      if (Queue.offerUnsafe(queue, { level, message, fields: compactLogFields(fields) })) {
        overflowing = false;
        return;
      }

      unreportedDrops += 1;
      droppedTotal += 1;
      if (!overflowing) {
        overflowing = true;
        unreportedOverflow = true;
      }
    };
  return {
    trace: at('Trace'),
    debug: at('Debug'),
    info: at('Info'),
    warn: at('Warn'),
    error: at('Error'),
  } satisfies CallbackLogger;
});
