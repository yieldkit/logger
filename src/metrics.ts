import { Clock, Effect, Metric } from 'effect';

/**
 * Number of entries in `durationMsBoundaries`: 15 finite bounds plus the `+Infinity` overflow
 * bucket that Effect adds as the last entry.
 */
const DURATION_BUCKET_COUNT = 16;

/**
 * Nanoseconds in one millisecond.
 */
const NANOS_PER_MILLI = 1_000_000n;

/**
 * Upper bound of the first duration bucket, in milliseconds.
 */
const DURATION_FIRST_BUCKET_MS = 5;

/**
 * Factor between two neighbouring duration buckets.
 */
const DURATION_BUCKET_FACTOR = 2;

/**
 * Histogram boundaries for durations in milliseconds: 15 finite bounds that start at 5 ms and
 * double up to 81,920 ms (about 82 s), then `+Infinity`. That suits requests, queries and jobs.
 */
export const durationMsBoundaries: ReadonlyArray<number> = Metric.exponentialBoundaries({
  start: DURATION_FIRST_BUCKET_MS,
  factor: DURATION_BUCKET_FACTOR,
  count: DURATION_BUCKET_COUNT,
});

/**
 * Creates a histogram of durations in milliseconds with `durationMsBoundaries`. `name` is the
 * metric name, such as `db_query_ms`, and `description` says what is measured.
 */
export const durationHistogram = (name: string, description: string): Metric.Histogram<number> =>
  Metric.histogram(name, { description, boundaries: durationMsBoundaries });

/**
 * Reads the monotonic time of the current `Clock`, in nanoseconds.
 */
const monotonicNanos: Effect.Effect<bigint> = Clock.clockWith((clock) => clock.monotonicTimeNanos);

/**
 * Wraps an effect so that the time it took, in milliseconds, is recorded in `histogram` whether it
 * succeeds, fails or is interrupted. The time is read from the clock's monotonic time
 * (`Clock.monotonicTimeNanos`), so a wall-clock step (NTP, a manual change) during the effect does
 * not distort it. `TestClock.adjust` advances it. A negative difference (possible only with a
 * custom clock) records 0.
 */
export const recordDurationMs =
  (
    histogram: Metric.Metric<number, unknown>,
  ): (<A, E, R>(self: Effect.Effect<A, E, R>) => Effect.Effect<A, E, R>) =>
  (self) =>
    Effect.flatMap(monotonicNanos, (start) =>
      self.pipe(
        Effect.onExit(() =>
          Effect.flatMap(monotonicNanos, (end) =>
            Metric.update(histogram, Math.max(0, nanosToMillis(end - start))),
          ),
        ),
      ),
    );

/**
 * Converts a nanosecond difference to milliseconds, keeping the fraction.
 */
const nanosToMillis = (nanos: bigint): number =>
  Number(nanos / NANOS_PER_MILLI) + Number(nanos % NANOS_PER_MILLI) / Number(NANOS_PER_MILLI);
