import type { Fiber, Scope } from 'effect';

import { Context, Effect, Layer, Logger, Scope as ScopeService } from 'effect';

import type { LogRedaction } from './redact.ts';

/**
 * Loggers that receive every record the fan-out logger sees, for sinks provided directly as a list
 * (`Layer.succeed(LogExportSinks, [logger])`). It is a context reference, so each runtime (or each
 * part of the program that a layer is provided to) has its own list. Empty by default. Sinks added
 * with {@link logExportSinkLayer}, such as the OTLP log exporter of `telemetryLayer`, are not in
 * this list: each is registered under a context key of its own, so sibling sink layers never
 * replace each other, and they reach the fan-out logger the same way.
 */
export const LogExportSinks: Context.Reference<ReadonlyArray<Logger.Logger<unknown, unknown>>> =
  Context.Reference<ReadonlyArray<Logger.Logger<unknown, unknown>>>(
    '@yieldkit/logger/LogExportSinks',
    { defaultValue: () => [] },
  );

/**
 * Start of the context key under which each {@link logExportSinkLayer} build registers its sink.
 */
const SINK_KEY_PREFIX = '@yieldkit/logger/LogExportSink/';

/**
 * Sinks of the {@link logExportSinkLayer} builds whose scopes are open, in the order they were
 * built, keyed by the context key each build provides. A fiber reaches a sink only when its context
 * holds that key, so the registry being process-wide never lets one runtime's records reach another
 * runtime's sink.
 */
const liveSinks = new Map<string, Logger.Logger<unknown, unknown>>();

/**
 * Number of sink layer builds so far, used to give each its own context key.
 */
let sinkBuilds = 0;

/**
 * Lists the sinks a record logged on `fiber` goes to: its {@link LogExportSinks}, then every live
 * {@link logExportSinkLayer} sink whose key is in its context.
 */
const sinksOf = (
  fiber: Fiber.Fiber<unknown, unknown>,
): ReadonlyArray<Logger.Logger<unknown, unknown>> => {
  const listed = fiber.getRef(LogExportSinks);
  if (liveSinks.size === 0) {
    return listed;
  }

  const sinks = [...listed];
  const context = fiber.context.mapUnsafe;
  for (const [key, sink] of liveSinks) {
    if (context.has(key)) {
      sinks.push(sink);
    }
  }

  return sinks;
};

/**
 * Builds the logger installed by `makeLoggerLayer` beside the console logger. It passes each
 * record, after `MinimumLogLevel` filtering and after `redaction`, to every sink of the fiber that
 * logged it: its {@link LogExportSinks} and the sinks of the {@link logExportSinkLayer} layers
 * provided to it. With no sinks it does nothing. A sink that throws is skipped for that record; the
 * other sinks and the logging effect are not affected.
 */
export const makeFanOutLogger = (redaction: LogRedaction): Logger.Logger<unknown, void> =>
  Logger.make((options) => {
    const sinks = sinksOf(options.fiber);
    if (sinks.length === 0) {
      return;
    }

    const redacted = redaction.redactLogOptions(options);
    for (const sink of sinks) {
      try {
        sink.log(redacted);
      } catch {
        // A broken sink must not fail the caller's effect or starve the sinks after it.
      }
    }
  });

/**
 * Builds a logger with `make` and adds it to the sinks of whatever this layer is provided to,
 * keeping the sinks already there. Sink layers compose in any way: merged as siblings
 * (`Layer.mergeAll(telemetryLayer(...), mySink)`), chained with `Layer.provide` (each sink layer
 * passes on the sink layers it was built with), or provided to one part of the program, where the
 * sink only sees that part's records. A {@link LogExportSinks} list given to it with `Layer.provide`
 * is not passed on; merge that list in beside it instead. Runtimes built on one memo map share a
 * layer instance and so its sink, so give each destination a fresh layer. `make` runs in the
 * layer's scope, so an exporter it opens lives as long as the layer. When that scope closes, the
 * logger is removed and stops receiving records before any finalizer that `make` registered (such
 * as its exporter's last flush) runs.
 */
export const logExportSinkLayer = <E, R>(
  make: Effect.Effect<Logger.Logger<unknown, unknown>, E, R>,
): Layer.Layer<never, E, Exclude<R, Scope.Scope>> =>
  Layer.fromBuildMemo((_memoMap, scope) =>
    Effect.gen(function* () {
      const logger = yield* make;
      const inherited = yield* Effect.context();
      sinkBuilds += 1;
      const key = `${SINK_KEY_PREFIX}${String(sinkBuilds)}`;
      let open = true;
      liveSinks.set(
        key,
        Logger.make<unknown, void>((options) => {
          if (open) {
            logger.log(options);
          }
        }),
      );
      yield* ScopeService.addFinalizer(
        scope,
        Effect.sync(() => {
          open = false;
          liveSinks.delete(key);
        }),
      );
      const provided = new Map<string, unknown>([[key, true]]);
      for (const [inheritedKey, value] of inherited.mapUnsafe) {
        if (inheritedKey.startsWith(SINK_KEY_PREFIX)) {
          provided.set(inheritedKey, value);
        }
      }

      return Context.makeUnsafe(provided);
    }).pipe(Effect.provideService(ScopeService.Scope, scope)),
  );
