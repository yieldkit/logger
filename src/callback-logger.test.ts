import { Effect, Exit, Logger, Metric, References } from 'effect';
import { describe, expect, it } from 'vite-plus/test';

import type { LogFields } from './types.ts';

import {
  CALLBACK_LOGGER_CAPACITY,
  callbackLoggerDropped,
  makeCallbackLogger,
} from './callback-logger.ts';
import { makeTestLogger } from './testing/index.ts';

/**
 * Resolves on the next macrotask, after the logging fiber had a chance to run.
 */
const nextTick = Effect.promise(
  () =>
    new Promise<void>((resolve) => {
      setImmediate(resolve);
    }),
);

/**
 * Runs `program` with a fresh in-memory logger at `Trace` and returns its records.
 */
const record = async <A>(
  program: Effect.Effect<A>,
): Promise<{ readonly value: A; readonly harness: ReturnType<typeof makeTestLogger> }> => {
  const harness = makeTestLogger({ minLevel: 'Trace' });
  const value = await Effect.runPromise(program.pipe(Effect.provide(harness.layer)));
  return { value, harness };
};

/**
 * Level and annotations of the record with `message`, or undefined when it was not logged.
 */
const summarize = (
  harness: ReturnType<typeof makeTestLogger>,
  message: string,
): readonly [string, LogFields] | undefined => {
  const entry = harness.records.find((candidate) => candidate.message === message);
  return entry === undefined ? undefined : [entry.level, entry.annotations];
};

describe('makeCallbackLogger', () => {
  it('writes lines with the creating fiber annotations and their own fields', async () => {
    const { harness } = await record(
      Effect.scoped(
        Effect.gen(function* () {
          const log = yield* makeCallbackLogger();
          setImmediate(() => log.info('from callback'));
          log.error('right away', { code: 42, skipped: undefined });
          log.debug('debug line');
          yield* nextTick;
          yield* nextTick;
        }),
      ).pipe(Effect.annotateLogs({ source: 'spec' })),
    );
    expect(summarize(harness, 'from callback')).toEqual(['INFO', { source: 'spec' }]);
    expect(summarize(harness, 'right away')).toEqual(['ERROR', { source: 'spec', code: 42 }]);
    expect(summarize(harness, 'debug line')).toEqual(['DEBUG', { source: 'spec' }]);
  });

  it('carries the trace and span ids of the span it was created in', async () => {
    const { harness } = await record(
      Effect.scoped(
        Effect.gen(function* () {
          const log = yield* makeCallbackLogger();
          log.warn('inside span');
          yield* nextTick;
        }),
      ).pipe(Effect.withSpan('callback-span')),
    );
    const [entry] = harness.records;
    expect(entry?.message).toBe('inside span');
    expect(entry?.traceId).toMatch(/^[0-9a-f]+$/);
    expect(entry?.spanId).toMatch(/^[0-9a-f]+$/);
  });

  it('writes queued lines before the scope finishes closing', async () => {
    const lines: Array<string> = [];
    const logger = Logger.make<unknown, void>((options) => {
      lines.push(String(options.message));
    });
    await Effect.runPromise(
      Effect.gen(function* () {
        yield* Effect.scoped(
          Effect.gen(function* () {
            yield* Effect.addFinalizer(() => Effect.sync(() => lines.push('earlier finalizer')));
            const log = yield* makeCallbackLogger();
            log.warn('queued one');
            log.warn('queued two');
          }),
        );
        lines.push('closed');
      }).pipe(
        Effect.provide(Logger.layer([logger])),
        Effect.provideService(References.MinimumLogLevel, 'Trace'),
      ),
    );

    expect(lines).toEqual(['queued one', 'queued two', 'earlier finalizer', 'closed']);
  });

  it('keeps writing after a line that a logger fails on', async () => {
    const { harness } = await record(
      Effect.scoped(
        Effect.gen(function* () {
          const log = yield* makeCallbackLogger();
          log.info('before');
          yield* nextTick;
          const revoked = Proxy.revocable({}, {});
          revoked.revoke();
          log.error('bad', { value: revoked.proxy });
          yield* nextTick;
          log.info('after');
          yield* nextTick;
        }),
      ),
    );
    expect(harness.records.map((entry) => entry.message)).toEqual(['before', 'bad', 'after']);
  });

  it('keeps writing when a logger throws on one line', async () => {
    const lines: Array<string> = [];
    const logger = Logger.make<unknown, void>((options) => {
      if (String(options.message) === 'explode') {
        throw new Error('sink broke');
      }

      lines.push(String(options.message));
    });
    const whileOpen = await Effect.runPromise(
      Effect.scoped(
        Effect.gen(function* () {
          const log = yield* makeCallbackLogger();
          log.info('explode');
          log.info('after');
          yield* nextTick;
          yield* nextTick;
          return [...lines];
        }),
      ).pipe(Effect.provide(Logger.layer([logger]))),
    );
    expect(whileOpen).toEqual(['after']);
  });

  it('shuts the queue down even when writing at close fails', async () => {
    let failing = false;
    const logger = Logger.make<unknown, void>(() => {
      if (failing) {
        throw new Error('sink broke');
      }
    });
    const closedLogger = await Effect.runPromise(
      Effect.scoped(
        Effect.gen(function* () {
          const log = yield* makeCallbackLogger();
          failing = true;
          log.info('queued at close');
          return log;
        }),
      ).pipe(Effect.provide(Logger.layer([logger]))),
    );
    expect(() => closedLogger.info('after close')).not.toThrow();
  });

  it('does not queue lines below the minimum level', async () => {
    const lines: Array<string> = [];
    const logger = Logger.make<unknown, void>((options) => {
      lines.push(String(options.message));
    });
    await Effect.runPromise(
      Effect.scoped(
        Effect.gen(function* () {
          const log = yield* makeCallbackLogger();
          log.debug('hidden');
          log.warn('shown');
          yield* nextTick;
        }),
      ).pipe(
        Effect.provide(Logger.layer([logger])),
        Effect.provideService(References.MinimumLogLevel, 'Info'),
      ),
    );
    expect(lines).toEqual(['shown']);
  });

  it('drops calls made after the scope closed without throwing', async () => {
    const { value: closedLogger, harness } = await record(
      Effect.scoped(
        Effect.gen(function* () {
          const log = yield* makeCallbackLogger();
          log.warn('queued at close');

          return log;
        }),
      ),
    );

    expect(() => closedLogger.info('after close')).not.toThrow();
    await Effect.runPromise(nextTick);

    expect(harness.records.map((entry) => entry.message)).toEqual(['queued at close']);
  });

  it('drops lines past the capacity, counts them and warns once per overflow', async () => {
    const { value: dropped, harness } = await record(
      Effect.scoped(
        Effect.gen(function* () {
          const log = yield* makeCallbackLogger({ capacity: 3 });
          for (let index = 0; index < 5; index += 1) {
            log.info(`burst ${String(index)}`);
          }

          yield* nextTick;
          log.info('after drain');
          yield* nextTick;
          return yield* Metric.value(callbackLoggerDropped);
        }),
      ).pipe(Effect.provideService(Metric.MetricRegistry, new Map())),
    );
    expect(harness.records.map((entry) => entry.message)).toEqual([
      'burst 0',
      'logger.callback.overflow',
      'burst 1',
      'burst 2',
      'after drain',
    ]);
    expect(summarize(harness, 'logger.callback.overflow')).toEqual([
      'WARN',
      { capacity: 3, droppedTotal: 2 },
    ]);
    expect(dropped.count).toBe(2);
  });

  it('holds CALLBACK_LOGGER_CAPACITY lines by default', async () => {
    const { harness } = await record(
      Effect.scoped(
        Effect.gen(function* () {
          const log = yield* makeCallbackLogger();
          for (let index = 0; index < CALLBACK_LOGGER_CAPACITY + 10; index += 1) {
            log.debug('line');
          }

          yield* nextTick;
        }),
      ),
    );
    const lines = harness.records.filter((entry) => entry.message === 'line');
    expect(lines).toHaveLength(CALLBACK_LOGGER_CAPACITY);
    expect(summarize(harness, 'logger.callback.overflow')?.[1]).toEqual({
      capacity: CALLBACK_LOGGER_CAPACITY,
      droppedTotal: 10,
    });
  });

  it('reports lines dropped just before the scope closes', async () => {
    const { value: dropped, harness } = await record(
      Effect.gen(function* () {
        yield* Effect.scoped(
          Effect.gen(function* () {
            const log = yield* makeCallbackLogger({ capacity: 1 });
            log.info('kept');
            log.info('dropped');
          }),
        );
        return yield* Metric.value(callbackLoggerDropped);
      }).pipe(Effect.provideService(Metric.MetricRegistry, new Map())),
    );
    expect(harness.records.map((entry) => entry.message)).toEqual([
      'kept',
      'logger.callback.overflow',
    ]);
    expect(dropped.count).toBe(1);
  });

  it('does not count calls made after the scope closed as drops', async () => {
    const { value: dropped, harness } = await record(
      Effect.gen(function* () {
        const log = yield* Effect.scoped(makeCallbackLogger({ capacity: 1 }));
        log.info('late one');
        log.info('late two');
        yield* nextTick;
        return yield* Metric.value(callbackLoggerDropped);
      }).pipe(Effect.provideService(Metric.MetricRegistry, new Map())),
    );
    expect(harness.records).toEqual([]);
    expect(dropped.count).toBe(0);
  });

  it.each([0, -1, 1.5, Number.NaN])('dies on capacity %s', async (capacity) => {
    const exit = await Effect.runPromiseExit(Effect.scoped(makeCallbackLogger({ capacity })));
    expect(Exit.isFailure(exit)).toBe(true);
  });
});
