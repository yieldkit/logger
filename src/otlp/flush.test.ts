import { Effect, Layer } from 'effect';
import { OtlpExporter } from 'effect/observability';
import { describe, expect, it } from 'vite-plus/test';

import { flushOtlp } from './flush.ts';

describe('flushOtlp', () => {
  it('flushes the installed exporter', async () => {
    let flushed = 0;
    const flusher = Layer.succeed(OtlpExporter.Flusher, {
      flush: Effect.sync(() => {
        flushed += 1;
      }),
      register: () => Effect.void,
    });
    await Effect.runPromise(flushOtlp.pipe(Effect.provide(flusher)));
    expect(flushed).toBe(1);
  });

  it('does nothing without an exporter', async () => {
    await expect(Effect.runPromise(flushOtlp)).resolves.toBeUndefined();
  });
});
