# Crashes and startup failures

## Crash handlers

`CrashHandlersLive` adds `uncaughtException` and `unhandledRejection` listeners to `process` while the layer is up. On a crash it:

1. logs `process.crashed` at Fatal with the value as a die cause and a `crashKind` annotation (`uncaughtException` or `unhandledRejection`);
2. runs the `flush` option, if you passed one (`flushOtlp` from `@yieldkit/logger/otlp` exports the buffered spans, metrics and logs);
3. calls `process.exit(1)`, whatever happened in steps 1 and 2.

Steps 1 and 2 share one `flushTimeout` (5 seconds). `exit(1)` runs when it passes, even if a logger or the flush hangs, unless that code blocks the thread synchronously. If the crash value can't be logged, a line without it is written and the flush still runs. A second crash is ignored.

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

Pass `disableErrorReporting: true`, or `runMain` prints the unredacted cause as well. A success or an interrupt-only exit (Ctrl-C, `SIGTERM`) goes to Effect's default teardown and keeps its exit code. `startupFailureTeardown` handles any failed exit, not only startup: a later failure is also printed as `failed to start: …`.

The line comes from `describeStartupFailure(cause, redaction?)`:

- `invalid configuration: <messages>` when every reason of the cause is a `ConfigError`, with the messages passed through `redactLogString`;
- `failed to start: <cause>` for anything else, rendered from a sanitized cause: `Redacted` values, sensitive keys and the [convenience shapes](redaction.md#convenience) are masked.

Both use the built-in sensitive names plus `redaction`. To mask your own keys on the terminal too, build the teardown with `makeStartupFailureTeardown(write, { redaction })`, passing the same `redaction` as the logger layer. It writes the line with `write` and exits with code 1 even when the failure value throws while it is read:

```ts
import { makeStartupFailureTeardown } from '@yieldkit/logger';

const teardown = makeStartupFailureTeardown((line) => console.error(line), { redaction });
```
