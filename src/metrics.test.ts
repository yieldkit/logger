import { Clock, Effect, Fiber, Metric } from 'effect';
import { TestClock } from 'effect/testing';
import { describe, expect, it } from 'vite-plus/test';

import { durationHistogram, durationMsBoundaries, recordDurationMs } from './metrics.ts';

/**
 * Runs `program` against a fresh metric registry and a `TestClock`.
 */
const runIsolated = <A, E>(program: Effect.Effect<A, E>): Promise<A> =>
  Effect.runPromise(
    program.pipe(
      Effect.provide(TestClock.layer()),
      Effect.provideService(Metric.MetricRegistry, new Map()),
    ),
  );

describe('durationMsBoundaries', () => {
  it('doubles from 5 ms over 15 finite buckets up to 81,920 ms, then +Infinity', () => {
    expect(durationMsBoundaries).toHaveLength(16);
    expect(durationMsBoundaries.slice(0, 5)).toEqual([5, 10, 20, 40, 80]);
    expect(durationMsBoundaries.slice(-2)).toEqual([81_920, Number.POSITIVE_INFINITY]);
  });
});

describe('recordDurationMs', () => {
  it('records the duration of a successful effect', async () => {
    const state = await runIsolated(
      Effect.gen(function* () {
        const histogram = durationHistogram('metrics_test_success_ms', 'test');
        const fiber = yield* Effect.sleep('120 millis').pipe(
          recordDurationMs(histogram),
          Effect.forkChild,
        );
        yield* TestClock.adjust('120 millis');
        yield* Fiber.join(fiber);

        return yield* Metric.value(histogram);
      }),
    );
    expect(state.count).toBe(1);
    expect(state.sum).toBe(120);
  });

  it('records the duration of a failing effect', async () => {
    const { failure, state } = await runIsolated(
      Effect.gen(function* () {
        const histogram = durationHistogram('metrics_test_failure_ms', 'test');
        const fiber = yield* Effect.sleep('30 millis').pipe(
          Effect.andThen(Effect.fail('boom')),
          recordDurationMs(histogram),
          Effect.flip,
          Effect.forkChild,
        );
        yield* TestClock.adjust('30 millis');
        const thrown = yield* Fiber.join(fiber);
        return { failure: thrown, state: yield* Metric.value(histogram) };
      }),
    );
    expect(failure).toBe('boom');
    expect(state.count).toBe(1);
    expect(state.sum).toBe(30);
  });

  it('records the elapsed time of an interrupted effect', async () => {
    const state = await runIsolated(
      Effect.gen(function* () {
        const histogram = durationHistogram('metrics_test_interrupt_ms', 'test');
        const fiber = yield* Effect.never.pipe(recordDurationMs(histogram), Effect.forkChild);
        yield* Effect.yieldNow;
        yield* TestClock.adjust('45 millis');
        yield* Fiber.interrupt(fiber);

        return yield* Metric.value(histogram);
      }),
    );
    expect(state.count).toBe(1);
    expect(state.sum).toBe(45);
  });
});

describe('recordDurationMs and the wall clock', () => {
  it('measures with the monotonic clock, so a wall-clock step is not recorded as time spent', async () => {
    let wallNanos = 1_000_000_000n;
    const steppingClock: Clock.Clock = {
      currentTimeMillisUnsafe: () => Number(wallNanos / 1_000_000n),
      currentTimeMillis: Effect.sync(() => Number(wallNanos / 1_000_000n)),
      currentTimeNanosUnsafe: () => wallNanos,
      currentTimeNanos: Effect.sync(() => wallNanos),
      monotonicTimeNanosUnsafe: () => 5_000_000n,
      monotonicTimeNanos: Effect.succeed(5_000_000n),
      sleep: () => Effect.void,
    };
    const state = await Effect.runPromise(
      Effect.gen(function* () {
        const histogram = durationHistogram('metrics_test_wall_step_ms', 'test');
        yield* Effect.sync(() => {
          wallNanos += 60_000_000_000n;
        }).pipe(recordDurationMs(histogram));
        return yield* Metric.value(histogram);
      }).pipe(
        Effect.provideService(Clock.Clock, steppingClock),
        Effect.provideService(Metric.MetricRegistry, new Map()),
      ),
    );
    expect(state.count).toBe(1);
    expect(state.sum).toBe(0);
  });
});
