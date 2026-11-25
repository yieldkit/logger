import { Console, Effect, Layer, Logger, ManagedRuntime } from 'effect';
import { describe, expect, it } from 'vite-plus/test';

import { makeLoggerLayer } from './layer.ts';
import { logExportSinkLayer, makeFanOutLogger } from './log-fan-out.ts';
import { defaultLogRedaction } from './redact.ts';

/**
 * Logger that appends the message of each record it receives to `messages`.
 */
const makeCollector = (messages: Array<unknown>): Logger.Logger<unknown, void> =>
  Logger.make((options) => {
    messages.push(options.message);
  });

/**
 * Console that drops every line, so console loggers stay quiet in these tests.
 */
const SILENT_CONSOLE: Console.Console = {
  ...console,
  log: () => undefined,
  error: () => undefined,
};

/**
 * Layer that installs only the fan-out logger with the built-in redaction.
 */
const FanOutOnly = Logger.layer([makeFanOutLogger(defaultLogRedaction)]);

/**
 * Layer that adds a collector for `messages` to the log export sinks.
 */
const collectorSink = (messages: Array<unknown>): Layer.Layer<never> =>
  logExportSinkLayer(Effect.succeed(makeCollector(messages)));

describe('logExportSinkLayer', () => {
  it('delivers records to a sink while its layer is up', async () => {
    const messages: Array<unknown> = [];
    await Effect.runPromise(
      Effect.gen(function* () {
        yield* Effect.logInfo('first');
        yield* Effect.logWarning('second');
      }).pipe(Effect.provide(Layer.mergeAll(FanOutOnly, collectorSink(messages)))),
    );
    expect(messages).toEqual([['first'], ['second']]);
  });

  it('stops delivering records once the layer scope closes', async () => {
    const messages: Array<unknown> = [];
    const runtime = ManagedRuntime.make(Layer.mergeAll(FanOutOnly, collectorSink(messages)));
    const fiberContext = await runtime.context();
    await Effect.runPromise(Effect.logInfo('inside').pipe(Effect.provide(fiberContext)));
    await runtime.dispose();
    await Effect.runPromise(Effect.logInfo('after').pipe(Effect.provide(fiberContext)));
    expect(messages).toEqual([['inside']]);
  });

  it('keeps the sinks already provided when another one is added', async () => {
    const first: Array<unknown> = [];
    const second: Array<unknown> = [];
    const sinks = collectorSink(second).pipe(Layer.provide(collectorSink(first)));
    await Effect.runPromise(
      Effect.logInfo('shared').pipe(Effect.provide(Layer.mergeAll(FanOutOnly, sinks))),
    );
    expect(first).toEqual([['shared']]);
    expect(second).toEqual([['shared']]);
  });

  it('redacts each record before a sink sees it', async () => {
    const messages: Array<unknown> = [];
    await Effect.runPromise(
      Effect.logInfo('call with Bearer abc123').pipe(
        Effect.provide(Layer.mergeAll(FanOutOnly, collectorSink(messages))),
      ),
    );
    expect(messages).toEqual([['call with Bearer <redacted>']]);
  });

  it('never sends one runtime’s records to the sink of another runtime', async () => {
    const seenByB: Array<unknown> = [];
    const seenByC: Array<unknown> = [];
    const quiet = { format: 'json', includeTracerLogger: false } as const;
    const runtimeB = ManagedRuntime.make(
      Layer.mergeAll(makeLoggerLayer(quiet), collectorSink(seenByB)),
    );
    await runtimeB.runPromise(Effect.void);
    const runtimeC = ManagedRuntime.make(
      Layer.mergeAll(makeLoggerLayer(quiet), collectorSink(seenByC)),
    );
    await runtimeC.runPromise(
      Effect.logInfo('from-runtime-C').pipe(Effect.provideService(Console.Console, SILENT_CONSOLE)),
    );
    await runtimeC.dispose();
    await runtimeB.dispose();
    expect(seenByC).toEqual([['from-runtime-C']]);
    expect(seenByB).toEqual([]);
  });

  it('keeps two runtimes that share a memo map apart', async () => {
    const seenByA: Array<unknown> = [];
    const seenByB: Array<unknown> = [];
    const memoMap = Effect.runSync(Layer.makeMemoMap);
    const base = makeLoggerLayer({ format: 'json', includeTracerLogger: false });
    const runtimeA = ManagedRuntime.make(Layer.provideMerge(collectorSink(seenByA), base), {
      memoMap,
    });
    const runtimeB = ManagedRuntime.make(Layer.provideMerge(collectorSink(seenByB), base), {
      memoMap,
    });
    await runtimeA.runPromise(Effect.void);
    await runtimeB.runPromise(Effect.void);
    const quiet = Effect.provideService(Console.Console, SILENT_CONSOLE);
    await runtimeA.runPromise(Effect.logInfo('only-in-A').pipe(quiet));
    await runtimeB.runPromise(Effect.logInfo('only-in-B').pipe(quiet));
    await runtimeA.dispose();
    await runtimeB.dispose();
    expect(seenByA).toEqual([['only-in-A']]);
    expect(seenByB).toEqual([['only-in-B']]);
  });

  it('passes on the sinks a sink layer was built with through Layer.provide', async () => {
    const first: Array<unknown> = [];
    const second: Array<unknown> = [];
    const sinks = collectorSink(second).pipe(Layer.provide(collectorSink(first)));
    await Effect.runPromise(
      Effect.logInfo('provided').pipe(Effect.provide(Layer.mergeAll(FanOutOnly, sinks))),
    );
    expect(first).toEqual([['provided']]);
    expect(second).toEqual([['provided']]);
  });

  it('delivers to every sink when sink layers are merged as siblings', async () => {
    const first: Array<unknown> = [];
    const second: Array<unknown> = [];
    await Effect.runPromise(
      Effect.logInfo('merged').pipe(
        Effect.provide(Layer.mergeAll(FanOutOnly, collectorSink(first), collectorSink(second))),
      ),
    );
    expect(first).toEqual([['merged']]);
    expect(second).toEqual([['merged']]);
  });

  it('delivers once to each sink when sink layers are provide-chained', async () => {
    const first: Array<unknown> = [];
    const second: Array<unknown> = [];
    const sinks = collectorSink(second).pipe(Layer.provideMerge(collectorSink(first)));
    await Effect.runPromise(
      Effect.logInfo('chained').pipe(Effect.provide(Layer.mergeAll(FanOutOnly, sinks))),
    );
    expect(first).toEqual([['chained']]);
    expect(second).toEqual([['chained']]);
  });

  it('keeps a sink provided to one sub-effect away from the records of the rest', async () => {
    const outer: Array<unknown> = [];
    const inner: Array<unknown> = [];
    await Effect.runPromise(
      Effect.gen(function* () {
        yield* Effect.logInfo('before');
        yield* Effect.logInfo('inside').pipe(Effect.provide(collectorSink(inner)));
        yield* Effect.logInfo('after');
      }).pipe(Effect.provide(Layer.mergeAll(FanOutOnly, collectorSink(outer)))),
    );
    expect(outer).toEqual([['before'], ['inside'], ['after']]);
    expect(inner).toEqual([['inside']]);
  });

  it('builds a sink layer used twice in one graph once', async () => {
    const messages: Array<unknown> = [];
    const sink = collectorSink(messages);
    const twice = Layer.mergeAll(sink, Layer.provide(Layer.empty, sink));
    await Effect.runPromise(
      Effect.logInfo('once').pipe(Effect.provide(Layer.mergeAll(FanOutOnly, twice))),
    );
    expect(messages).toEqual([['once']]);
  });

  it('keeps delivering to the other sinks when one sink throws', async () => {
    const messages: Array<unknown> = [];
    const throwing = logExportSinkLayer(
      Effect.succeed(
        Logger.make(() => {
          throw new Error('sink broke');
        }),
      ),
    );
    const exit = await Effect.runPromiseExit(
      Effect.logInfo('survives').pipe(
        Effect.provide(Layer.mergeAll(FanOutOnly, throwing, collectorSink(messages))),
      ),
    );
    expect(exit._tag).toBe('Success');
    expect(messages).toEqual([['survives']]);
  });

  it('reaches a sink provided as a sibling of the logger layer', async () => {
    const messages: Array<unknown> = [];
    const layer = Layer.mergeAll(
      makeLoggerLayer({ format: 'json', includeTracerLogger: false }),
      collectorSink(messages),
    );
    await Effect.runPromise(
      Effect.logInfo('sibling').pipe(
        Effect.provide(layer),
        Effect.provideService(Console.Console, SILENT_CONSOLE),
      ),
    );
    expect(messages).toEqual([['sibling']]);
  });
});

describe('makeFanOutLogger', () => {
  it('does nothing when no sink is provided', async () => {
    await expect(
      Effect.runPromise(Effect.logInfo('unheard').pipe(Effect.provide(FanOutOnly))),
    ).resolves.toBeUndefined();
  });
});
