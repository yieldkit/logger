# Crashes and startup failures

## Crash handlers

`CrashHandlersLive` adds `uncaughtException` and `unhandledRejection` listeners to `process` while the layer is up. On a crash it:

1. logs `process.crashed` at Fatal with the value as a die cause and a `crashKind` annotation (`uncaughtException` or `unhandledRejection`);
2. runs the `flush` option, if you passed one (`flushOtlp` from `@yieldkit/logger/otlp` exports the buffered spans, metrics and logs);
3. calls `process.exit(1)`, whatever happened in steps 1 and 2.

Steps 1 and 2 share one `flushTimeout` (5 seconds). The deadline runs on its own fiber, so `exit(1)` is called by the deadline even when a logger or the flush is uninterruptible and never yields to the interruption; the stuck work is left running and dies with the process. Only code that blocks the thread synchronously (a busy loop in a logger or flusher) can hold the exit back, because no timer fires until it returns. `exit` is called exactly once. `flushOtlp` cannot wait for an OTLP export already in flight (see [Flushing](telemetry.md#flushing)), so a Fatal record that fills a batch of 1,000 can be lost on exit. When the crash value cannot be logged, the flush still runs. The loggers `LoggerLive` and `makeLoggerLayer` install never throw: one that cannot write the line writes `process.crashed` again without the cause or annotations, so `crashKind` is missing from it. A logger you install yourself that throws on the crash value gets a Fatal `process.crashed` line with `crashValue: 'unloggable'` instead. A second crash while the first is handled is ignored.

The handlers log through the loggers that were in context when the layer was built, so build the layer on top of the logger: `CrashHandlersLive.pipe(Layer.provideMerge(ObservabilityLive))`. As a sibling in `Layer.mergeAll` it doesn't see those loggers, and crashes reach Effect's default logger unredacted.

`makeCrashHandlersLayer(options: CrashHandlerOptions)` takes the defaults as options:

<!-- prettier-ignore -->
```ts
makeCrashHandlersLayer({
  flush: flushOtlp,          // optional; runs after the Fatal line, in the layer's context
  flushTimeout: '5 seconds', // not a finite, positive duration: the layer dies when it is built
  exit: process.exit,        // called with 1 afterwards
  target: process,           // anything with on/off, such as an EventEmitter in tests
});
```

In a runtime without a global `process`, pass both `target` and `exit`, or the layer dies when it is built.

## Startup failures

A layer that fails to build (an invalid `LOG_LEVEL`, an unreachable database) fails the program before the logger is up, and `runMain` would print the raw cause. `startupFailureTeardown` prints one redacted line to `console.error` instead and exits with code 1:

```ts
import { BunRuntime } from '@effect/platform-bun';
import { startupFailureTeardown } from '@yieldkit/logger';
import { Effect } from 'effect';

program.pipe(
  Effect.provide(MainLive),
  BunRuntime.runMain({ disableErrorReporting: true, teardown: startupFailureTeardown }),
);
```

Pass `disableErrorReporting: true`, or `runMain` prints the unredacted cause as well. A success or an interrupt-only exit (Ctrl-C, `SIGTERM`) goes to Effect's default teardown and keeps its exit code.

The line comes from `describeStartupFailure(cause, redaction?)`:

- `invalid configuration: <messages>` when every reason of the cause is a `ConfigError`, with the messages passed through `redactLogString`;
- `failed to start: <cause>` for anything else, rendered from a sanitized cause, so a secret in an error message or span name is masked.

Both use the built-in sensitive names plus `redaction`. To mask your own keys on the terminal too, build the teardown with `makeStartupFailureTeardown(write, { redaction })`, passing the same `redaction` as the logger layer. It writes the line with `write` and exits with code 1 even when the failure value throws while it is read:

```ts
import { makeStartupFailureTeardown } from '@yieldkit/logger';

const teardown = makeStartupFailureTeardown((line) => console.error(line), { redaction });
```
