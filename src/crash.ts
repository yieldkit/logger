import {
  Cause,
  Duration,
  Effect,
  Exit,
  Layer,
  Option,
  Predicate,
  Redactable,
  Runtime,
} from 'effect';

import type { RedactionOptions } from './credentials.ts';

import { logFatal } from './context.ts';
import { defaultLogRedaction, makeLogRedaction } from './redact.ts';

/**
 * Process event that carries a crash.
 */
type CrashEvent = 'uncaughtException' | 'unhandledRejection';

/**
 * Listener registered for a crash event. It receives the thrown or rejected value.
 */
type CrashListener = (error: unknown) => void;

/**
 * Where crash listeners are registered. Node's and Bun's `process` fits, and so does an
 * `EventEmitter`.
 */
export type CrashTarget = {
  /**
   * Adds a listener for a crash event.
   */
  readonly on: (event: CrashEvent, listener: CrashListener) => void;

  /**
   * Removes a listener added with `on`.
   */
  readonly off: (event: CrashEvent, listener: CrashListener) => void;
};

/**
 * Options for `makeCrashHandlersLayer`.
 */
export type CrashHandlerOptions = {
  /**
   * Called once with exit code 1 when the crash was logged and flushed, or when `flushTimeout`
   * passed first, even if the flush is still running. Defaults to `process.exit`.
   */
  readonly exit?: ((code: number) => void) | undefined;

  /**
   * Object the `uncaughtException` and `unhandledRejection` listeners are added to and removed
   * from. Defaults to `process`.
   */
  readonly target?: CrashTarget | undefined;

  /**
   * Runs after the Fatal line and before the exit, in the context the layer was built in. Use it to
   * flush buffered exporters, such as `flushOtlp` from `@yieldkit/logger/otlp`. Defaults to doing
   * nothing.
   */
  readonly flush?: Effect.Effect<void> | undefined;

  /**
   * Longest time to wait for the Fatal line and the flush before exiting. Defaults to five seconds.
   * A value that is not a finite, positive duration (`NaN`, zero, negative or infinite included)
   * makes the layer die when it is built, so a bad setting shows up at startup rather than at the
   * first crash.
   */
  readonly flushTimeout?: Duration.Input | undefined;
};

/**
 * Default `CrashHandlerOptions.flushTimeout`.
 */
const DEFAULT_FLUSH_TIMEOUT: Duration.Input = '5 seconds';

/**
 * Exit code used after a crash.
 */
const CRASH_EXIT_CODE = 1;

/**
 * Exit code used after a program fails to start or fails later with a non-interrupt cause.
 */
const STARTUP_FAILURE_EXIT_CODE = 1;

/**
 * Message of the Fatal line written for a crash.
 */
const CRASH_MESSAGE = 'process.crashed';

/**
 * `crashValue` annotation of the fallback Fatal line written when the crash value itself cannot be
 * logged.
 */
const UNLOGGABLE_CRASH_VALUE = 'unloggable';

/**
 * The parts of the global `process` the handlers use. The package does not depend on Node types.
 */
type ProcessGlobal = CrashTarget & { readonly exit: (code: number) => void };

/**
 * True when `value` has the `on`, `off` and `exit` functions of a process object.
 */
const isProcessGlobal = (value: unknown): value is ProcessGlobal =>
  typeof value === 'object' &&
  Predicate.hasProperty(value, 'on') &&
  typeof value.on === 'function' &&
  Predicate.hasProperty(value, 'off') &&
  typeof value.off === 'function' &&
  Predicate.hasProperty(value, 'exit') &&
  typeof value.exit === 'function';

/**
 * Reads the global `process`, or returns undefined in a runtime that has none.
 */
const readProcessGlobal = (): ProcessGlobal | undefined => {
  const candidate = Predicate.hasProperty(globalThis, 'process') ? globalThis.process : undefined;
  return isProcessGlobal(candidate) ? candidate : undefined;
};

/**
 * Resolves the target and exit function from `options`, falling back to the global `process`. Dies
 * when one is missing and the runtime has no `process`.
 */
const resolveCrashRuntime = (
  options: CrashHandlerOptions,
): Effect.Effect<{ readonly target: CrashTarget; readonly exit: (code: number) => void }> =>
  Effect.suspend(() => {
    const processGlobal = readProcessGlobal();
    const target = options.target ?? processGlobal;
    const exit = options.exit ?? processGlobal?.exit.bind(processGlobal);
    if (target === undefined || exit === undefined) {
      return Effect.die(
        new Error('crash handlers need a global `process`, or both `target` and `exit` options'),
      );
    }

    return Effect.succeed({ target, exit });
  });

/**
 * Logs the crash at Fatal. When that fails or dies (a logger that throws, say), a fixed Fatal line
 * without the crash value is tried instead, and a failure of that one is dropped, so reporting
 * never stops before the flush.
 */
const logCrash = (kind: CrashEvent, error: unknown): Effect.Effect<void> =>
  logFatal(CRASH_MESSAGE, Cause.die(error), { crashKind: kind }).pipe(
    Effect.catchCause(() =>
      logFatal(CRASH_MESSAGE, undefined, { crashKind: kind, crashValue: UNLOGGABLE_CRASH_VALUE }),
    ),
    Effect.ignoreCause,
  );

/**
 * Logs the crash at Fatal and then runs `flush`. Logging never fails, so the flush runs even when
 * the crash value could not be logged. Neither step is made uninterruptible here, so the flush
 * timeout interrupts an interruptible flush; one that is not interruptible keeps running, and the
 * separate deadline fiber exits without waiting for it.
 */
const reportCrash = (
  kind: CrashEvent,
  error: unknown,
  flush: Effect.Effect<void>,
): Effect.Effect<void> => logCrash(kind, error).pipe(Effect.andThen(flush));

/**
 * Decodes `flushTimeout`, dying with a message that names the option when it is not a finite,
 * positive duration. `NaN` (from `Number` of an unset variable) decodes to zero, which would exit
 * before the Fatal line is written, and an infinite timeout would never exit.
 */
const decodeFlushTimeout = (
  flushTimeout: Duration.Input | undefined,
): Effect.Effect<Duration.Duration> =>
  Effect.suspend(() => {
    const decoded = Duration.fromInput(flushTimeout ?? DEFAULT_FLUSH_TIMEOUT);
    if (
      Option.isNone(decoded) ||
      !Duration.isFinite(decoded.value) ||
      !Duration.isPositive(decoded.value)
    ) {
      return Effect.die(
        new Error('invalid crash handler flushTimeout: expected a finite, positive duration'),
      );
    }

    return Effect.succeed(decoded.value);
  });

/**
 * Adds `listener` to `target` for `event` until the current scope closes. Each listener is acquired
 * on its own, so when adding a later one throws, the earlier ones are still removed.
 */
const listenScoped = (target: CrashTarget, event: CrashEvent, listener: CrashListener) =>
  Effect.acquireRelease(
    Effect.sync(() => {
      target.on(event, listener);
    }),
    () =>
      Effect.sync(() => {
        target.off(event, listener);
      }),
  );

/**
 * Registers `uncaughtException` and `unhandledRejection` listeners while the layer is up and
 * removes them when its scope closes.
 *
 * Each crash is logged at Fatal as `process.crashed` with a die cause and a `crashKind` annotation,
 * through the loggers and annotations that were in the context when the layer was built, and then
 * `options.flush` runs in that same context. When a logger throws on the crash value, a Fatal line
 * with `crashValue: 'unloggable'` is written instead; the loggers `makeLoggerLayer` installs never
 * throw, and write `process.crashed` without the cause and annotations. The flush runs either way,
 * bounded together with the log line by `flushTimeout`, and `exit(1)` runs once, when reporting
 * ends or when `flushTimeout` has passed, whichever comes first. The deadline runs on its own
 * fiber, so a log line or flush that cannot be interrupted does not delay the exit; only code that
 * blocks the thread synchronously (a busy loop in a logger or flusher) can, since no timer fires
 * until it returns. A second crash while the first is being handled does nothing, so the first
 * handler still exits.
 *
 * Registering a listener replaces Node's own crash, which is why the handler exits itself. Build
 * this layer with the logger layers provided to it (`Layer.provide`), because a sibling in
 * `Layer.mergeAll` does not see the loggers its sibling installs.
 */
export const makeCrashHandlersLayer = (options: CrashHandlerOptions = {}): Layer.Layer<never> =>
  Layer.effectDiscard(
    Effect.gen(function* () {
      const { target, exit } = yield* resolveCrashRuntime(options);
      const flushTimeout = yield* decodeFlushTimeout(options.flushTimeout);
      const run = Effect.runForkWith(yield* Effect.context());
      let handling = false;

      /**
       * Builds the listener for one kind of crash. It ignores every crash after the first.
       */
      const handler =
        (kind: CrashEvent): CrashListener =>
        (error) => {
          if (handling) {
            return;
          }

          handling = true;
          let exited = false;

          /**
           * Calls `exit(1)` the first time it runs and does nothing after that, so the deadline and
           * the end of reporting can both reach it.
           */
          const exitOnce = Effect.sync(() => {
            if (!exited) {
              exited = true;
              exit(CRASH_EXIT_CODE);
            }
          });
          /**
           * Exits once `flushTimeout` has passed. It runs on its own fiber, so an uninterruptible
           * log line or flush cannot hold it back; it is interrupted when reporting ends first.
           */
          const deadline = run(Effect.sleep(flushTimeout).pipe(Effect.andThen(exitOnce)));
          run(
            reportCrash(kind, error, options.flush ?? Effect.void).pipe(
              Effect.timeout(flushTimeout),
              Effect.ignoreCause,
              Effect.ensuring(
                exitOnce.pipe(
                  Effect.andThen(
                    Effect.sync(() => {
                      deadline.interruptUnsafe();
                    }),
                  ),
                ),
              ),
            ),
          );
        };
      const onException = handler('uncaughtException');
      const onRejection = handler('unhandledRejection');

      yield* listenScoped(target, 'uncaughtException', onException);
      yield* listenScoped(target, 'unhandledRejection', onRejection);
    }),
  );

/**
 * `makeCrashHandlersLayer()` with the default options: the global `process`, `process.exit` and a
 * five second flush timeout.
 */
export const CrashHandlersLive: Layer.Layer<never> = makeCrashHandlersLayer();

/**
 * Line written when a startup failure cannot be described at all.
 */
const UNDESCRIBABLE_STARTUP_FAILURE = 'failed to start: [Unserializable]';

/**
 * Options for {@link makeStartupFailureTeardown}.
 */
export type StartupFailureOptions = {
  /**
   * Redaction options (extra sensitive and allowed names, `scrubText`) used when the failure is
   * described. Pass the same value as the logger layer's `redaction`, so a key masked in log lines
   * is masked on the terminal too.
   */
  readonly redaction?: RedactionOptions | undefined;
};

/**
 * Returns the message of an Effect `Config.ConfigError` (a `ConfigError` tag and a string
 * `message`), or `undefined` for any other value. A `Redactable` value is not read here, so it is
 * described by its redacted form like any other failure. Each property is read once, and a value
 * that throws while it is read is not a `ConfigError`. `ConfigError` is not a Schema class, so
 * `Schema.is` cannot check it.
 */
const configErrorMessage = (value: unknown): string | undefined => {
  try {
    if (
      Redactable.isRedactable(value) ||
      !Predicate.isTagged(value, 'ConfigError') ||
      !Predicate.hasProperty(value, 'message')
    ) {
      return undefined;
    }

    const message: unknown = value.message;
    return typeof message === 'string' ? message : undefined;
  } catch {
    return undefined;
  }
};

/**
 * Renders a failure to build the app (for example a bad `LOG_LEVEL`) as console text, for use where
 * the loggers are not available. When every reason of the cause is a `ConfigError` failure, the
 * text is `invalid configuration: ` plus their redacted messages. Any other cause, including a
 * `ConfigError` next to a defect, becomes `failed to start: ` plus the sanitized pretty cause, so
 * no reason is hidden and a secret in an error message or span name never reaches the terminal.
 * Redacts with the built-in sensitive names plus `redaction`.
 */
export const describeStartupFailure = (
  cause: Cause.Cause<unknown>,
  redaction?: RedactionOptions,
): string => {
  const rules = redaction === undefined ? defaultLogRedaction : makeLogRedaction(redaction);
  const messages = cause.reasons.flatMap((reason) => {
    const message = Cause.isFailReason(reason) ? configErrorMessage(reason.error) : undefined;
    return message === undefined ? [] : [message];
  });
  if (messages.length > 0 && messages.length === cause.reasons.length) {
    const redacted = messages.map((message) => rules.redactString(message));
    return `invalid configuration: ${redacted.join('; ')}`;
  }

  return `failed to start: ${Cause.pretty(rules.sanitizeCause(cause))}`;
};

/**
 * Builds a `Runtime.Teardown` for `runMain` that reports a failed program with
 * {@link describeStartupFailure}, redacting with the built-in sensitive names plus
 * `options.redaction`. A success or an interrupt-only exit (Ctrl-C, `SIGTERM`) goes to
 * `Runtime.defaultTeardown`, which keeps its exit code. Any other failure is passed to `write`
 * once, as one string, and exits with code 1, even when the failure cannot be described or `write`
 * throws. Pair it with `disableErrorReporting: true`, or `runMain` also prints the raw, unredacted
 * cause.
 */
export const makeStartupFailureTeardown =
  (write: (line: string) => void, options: StartupFailureOptions = {}): Runtime.Teardown =>
  (exit, onExit) => {
    if (Exit.isSuccess(exit) || Cause.hasInterruptsOnly(exit.cause)) {
      Runtime.defaultTeardown(exit, onExit);
      return;
    }

    let line = UNDESCRIBABLE_STARTUP_FAILURE;
    try {
      line = describeStartupFailure(exit.cause, options.redaction);
    } catch {
      // Keep the fixed line: the exit code matters more than the description.
    }

    try {
      write(line);
    } finally {
      onExit(STARTUP_FAILURE_EXIT_CODE);
    }
  };

/**
 * {@link makeStartupFailureTeardown} writing to `console.error`, for `BunRuntime.runMain({
 * disableErrorReporting: true, teardown: startupFailureTeardown })`.
 */
export const startupFailureTeardown: Runtime.Teardown = makeStartupFailureTeardown((line) => {
  console.error(line);
});
