import { describe, expect, it } from 'vite-plus/test';

/**
 * `Error.stackTraceLimit` as the runtime defines it, restored after each locked section.
 */
const writable = Object.getOwnPropertyDescriptor(Error, 'stackTraceLimit');

/**
 * Runs `body` with `Error.stackTraceLimit` read-only, as in a locked-down (SES-style) runtime, and
 * restores it afterwards so the test runner can set it again.
 */
const withLockedStackTraceLimit = async <A>(body: () => A | Promise<A>): Promise<A> => {
  Object.defineProperty(Error, 'stackTraceLimit', {
    value: 10,
    writable: false,
    configurable: true,
  });
  try {
    return await body();
  } finally {
    if (writable !== undefined) {
      Object.defineProperty(Error, 'stackTraceLimit', writable);
    }
  }
};

// Such a runtime locks the property before any library loads, and Effect checks it once on load,
// so Effect and the redaction modules are imported while it is locked.
const { Cause, Effect, Exit, Tracer } = await withLockedStackTraceLimit(() => import('effect'));
const { sanitizeCause, withTracerRedaction } = await withLockedStackTraceLimit(
  () => import('./redact.ts'),
);

describe('sanitizeCause with a read-only Error.stackTraceLimit', () => {
  it('still renders and scrubs the cause', async () => {
    const rendered = await withLockedStackTraceLimit(() =>
      Cause.pretty(sanitizeCause(Cause.fail(new Error('locked Bearer lock-tok')))),
    );
    expect(rendered).toContain('locked Bearer <redacted>');
  });

  it('ends a failed span under withTracerRedaction without throwing', async () => {
    const tracer = withTracerRedaction(
      Tracer.make({ span: (options) => new Tracer.NativeSpan(options) }),
    );
    const exit = await withLockedStackTraceLimit(() =>
      Effect.runPromiseExit(
        Effect.fail('span failure').pipe(Effect.withSpan('op'), Effect.withTracer(tracer)),
      ),
    );
    const reasons = Exit.isFailure(exit) ? exit.cause.reasons : [];
    expect(reasons.map((reason) => (Cause.isFailReason(reason) ? reason.error : reason))).toEqual([
      'span failure',
    ]);
  });
});
