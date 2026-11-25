import { Effect, Option } from 'effect';
import { OtlpExporter } from 'effect/observability';

/**
 * Exports everything the OTLP exporters still buffer, when `telemetryLayer` or `tracingLayer`
 * provided an `OtlpExporter.Flusher`, and does nothing otherwise. Pass it as the `flush` option of
 * `makeCrashHandlersLayer`, so a crash's Fatal line and the spans leading up to it reach the
 * collector before the process exits.
 */
export const flushOtlp: Effect.Effect<void> = Effect.flatMap(
  Effect.serviceOption(OtlpExporter.Flusher),
  (flusher) => (Option.isSome(flusher) ? flusher.value.flush : Effect.void),
);
