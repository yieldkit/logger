import type { Duration, Scope } from 'effect';

import {
  Cause,
  Config,
  ConfigProvider,
  Data,
  Effect,
  Exit,
  Layer,
  Logger,
  Redactable,
} from 'effect';
import { EventEmitter } from 'node:events';
import { describe, expect, it } from 'vite-plus/test';

import type { CrashHandlerOptions } from './crash.ts';

import { readLoggerConfig } from './config.ts';
import {
  describeStartupFailure,
  makeCrashHandlersLayer,
  makeStartupFailureTeardown,
} from './crash.ts';
import { makeStartupFailureTeardown as makeStartupFailureTeardownFromIndex } from './index.ts';
import { makeTestLogger } from './testing/index.ts';

/**
 * Startup failure whose message carries a secret, as an app's failed layer might report it.
 */
class StartupTestError extends Data.TaggedError('StartupTestError')<{
  readonly message: string;
}> {}

/**
 * Builds a crash layer on an `EventEmitter` target with a recorded `exit`, and an in-memory logger
 * provided to it. `exited` resolves with the exit code.
 */
const setup = (options: Pick<CrashHandlerOptions, 'flush' | 'flushTimeout'> = {}) => {
  const target = new EventEmitter();
  const harness = makeTestLogger();
  const exitCodes: Array<number> = [];
  const { promise: exited, resolve } = Promise.withResolvers<number>();
  const exit = (code: number): void => {
    exitCodes.push(code);
    resolve(code);
  };
  const layer = makeCrashHandlersLayer({ ...options, target, exit }).pipe(
    Layer.provide(harness.layer),
  );
  return { target, harness, exitCodes, exited, layer };
};

/**
 * Builds `layer` in a fresh scope, runs `use`, and closes the scope.
 */
const withLayer = <A>(
  layer: Layer.Layer<never>,
  use: Effect.Effect<A, never, Scope.Scope>,
): Promise<A> => Effect.runPromise(Effect.scoped(Layer.build(layer).pipe(Effect.andThen(use))));

describe('makeCrashHandlersLayer', () => {
  it('logs an uncaught exception at Fatal as a die cause and exits with 1', async () => {
    const { target, harness, exitCodes, exited, layer } = setup();
    await withLayer(
      layer,
      Effect.promise(async () => {
        target.emit('uncaughtException', new Error('boom'));
        await exited;
      }),
    );

    expect(exitCodes).toEqual([1]);
    expect(harness.records).toHaveLength(1);
    const [record] = harness.records;
    expect(record?.level).toBe('FATAL');
    expect(record?.message).toBe('process.crashed');
    expect(record?.error?.kind).toBe('die');
    expect(record?.annotations).toMatchObject({ crashKind: 'uncaughtException' });
  });

  it('logs an unhandled rejection at Fatal as a die cause and exits with 1', async () => {
    const { target, harness, exitCodes, exited, layer } = setup();
    await withLayer(
      layer,
      Effect.promise(async () => {
        target.emit('unhandledRejection', 'rejected');
        await exited;
      }),
    );

    expect(exitCodes).toEqual([1]);
    expect(harness.records).toHaveLength(1);
    expect(harness.records[0]?.error?.kind).toBe('die');
    expect(harness.records[0]?.annotations).toMatchObject({ crashKind: 'unhandledRejection' });
  });

  it('removes both listeners when the scope closes', async () => {
    const { target, layer } = setup();
    const during = await withLayer(
      layer,
      Effect.sync(() => [
        target.listenerCount('uncaughtException'),
        target.listenerCount('unhandledRejection'),
      ]),
    );
    expect(during).toEqual([1, 1]);
    expect(target.listenerCount('uncaughtException')).toBe(0);
    expect(target.listenerCount('unhandledRejection')).toBe(0);
  });

  it('handles only the first of several crashes', async () => {
    const { target, harness, exitCodes, exited, layer } = setup();
    await withLayer(
      layer,
      Effect.promise(async () => {
        target.emit('uncaughtException', new Error('first'));
        target.emit('unhandledRejection', new Error('second'));
        await exited;
      }),
    );

    expect(exitCodes).toEqual([1]);
    expect(harness.records).toHaveLength(1);
    expect(harness.records[0]?.annotations).toMatchObject({ crashKind: 'uncaughtException' });
  });

  it('exits after the flush timeout when the flush never completes', async () => {
    const flushStarted = Promise.withResolvers<void>();
    const flush = Effect.sync(() => flushStarted.resolve()).pipe(Effect.andThen(Effect.never));
    const { target, harness, exitCodes, exited, layer } = setup({
      flush,
      flushTimeout: '50 millis',
    });
    await withLayer(
      layer,
      Effect.promise(async () => {
        target.emit('uncaughtException', new Error('stuck'));
        await exited;
      }),
    );

    await flushStarted.promise;
    expect(exitCodes).toEqual([1]);
    expect(harness.records).toHaveLength(1);
  });

  it('exits by the flush timeout even when the flush is uninterruptible', async () => {
    const flushEnded = Promise.withResolvers<void>();
    const flush = Effect.sleep('1 second').pipe(
      Effect.ensuring(Effect.sync(() => flushEnded.resolve())),
      Effect.uninterruptible,
    );
    const { target, exitCodes, exited, layer } = setup({ flush, flushTimeout: '50 millis' });
    const elapsedMs = await withLayer(
      layer,
      Effect.promise(async () => {
        const started = performance.now();
        target.emit('uncaughtException', new Error('stuck'));
        await exited;
        return performance.now() - started;
      }),
    );
    expect(elapsedMs).toBeLessThan(500);
    await flushEnded.promise;
    expect(exitCodes).toEqual([1]);
  });

  it('runs the flush option before exiting', async () => {
    const order: Array<string> = [];
    const flush = Effect.sync(() => order.push('flush'));
    const { target, exitCodes, exited, layer } = setup({ flush });
    await withLayer(
      layer,
      Effect.promise(async () => {
        target.emit('uncaughtException', new Error('flush me'));
        await exited;
      }),
    );

    expect(exitCodes).toEqual([1]);
    expect(order).toEqual(['flush']);
  });

  it('flushes before calling exit', async () => {
    const target = new EventEmitter();
    const order: Array<string> = [];
    const { promise: exited, resolve } = Promise.withResolvers<void>();
    const flush = Effect.sync(() => order.push('flush'));
    const layer = makeCrashHandlersLayer({
      target,
      flush,
      exit: () => {
        order.push('exit');
        resolve();
      },
    }).pipe(Layer.provide(makeTestLogger().layer));
    await withLayer(
      layer,
      Effect.promise(async () => {
        target.emit('uncaughtException', new Error('order'));
        await exited;
      }),
    );
    expect(order).toEqual(['flush', 'exit']);
  });

  it('masks a credential carried by the crash value', async () => {
    const { target, harness, exited, layer } = setup();
    await withLayer(
      layer,
      Effect.promise(async () => {
        target.emit('uncaughtException', new Error('upstream rejected Bearer crash-secret'));
        await exited;
      }),
    );
    expect(JSON.stringify(harness.records)).not.toContain('crash-secret');
    expect(harness.records[0]?.error?.message).toBe('upstream rejected Bearer <redacted>');
  });

  it('writes a fallback Fatal line and still flushes when the crash value cannot be logged', async () => {
    const target = new EventEmitter();
    const lines: Array<unknown> = [];
    let flushed = false;
    const { promise: exited, resolve } = Promise.withResolvers<void>();
    const picky = Logger.make((options) => {
      if (options.cause.reasons.length > 0) {
        throw new Error('logger cannot render this cause');
      }

      lines.push(options.message);
    });
    const flush = Effect.sync(() => {
      flushed = true;
    });
    const layer = makeCrashHandlersLayer({ target, flush, exit: () => resolve() }).pipe(
      Layer.provide(Logger.layer([picky])),
    );
    await withLayer(
      layer,
      Effect.promise(async () => {
        target.emit('unhandledRejection', Object.create(null));
        await exited;
      }),
    );
    expect(lines).toEqual([['process.crashed']]);
    expect(flushed).toBe(true);
  });

  it.each<Duration.Input>([Number.NaN, 0, -5, '-1 seconds', Number.POSITIVE_INFINITY])(
    'dies at build time on a flushTimeout of %s',
    async (flushTimeout) => {
      const exit = await Effect.runPromiseExit(
        Effect.scoped(
          Layer.build(
            makeCrashHandlersLayer({
              target: new EventEmitter(),
              exit: () => undefined,
              flushTimeout,
            }),
          ),
        ),
      );
      expect(Exit.isFailure(exit) && Cause.hasDies(exit.cause)).toBe(true);
    },
  );

  it('dies at build time on a flushTimeout that is not a duration', async () => {
    const target = new EventEmitter();
    const exit = await Effect.runPromiseExit(
      Effect.scoped(
        Layer.build(
          makeCrashHandlersLayer({ target, exit: () => undefined, flushTimeout: '1e3 millis' }),
        ),
      ),
    );
    expect(Exit.isFailure(exit) && Cause.hasDies(exit.cause)).toBe(true);
    expect(target.listenerCount('uncaughtException')).toBe(0);
  });

  it('removes the first listener when adding the second one throws', async () => {
    const registered: Array<string> = [];
    const target = {
      on: (event: string) => {
        if (event === 'unhandledRejection') {
          throw new Error('cannot listen');
        }

        registered.push(event);
      },
      off: (event: string) => {
        registered.splice(registered.indexOf(event), 1);
      },
    };
    const exit = await Effect.runPromiseExit(
      Effect.scoped(Layer.build(makeCrashHandlersLayer({ target, exit: () => undefined }))),
    );
    expect(Exit.isFailure(exit)).toBe(true);
    expect(registered).toEqual([]);
  });
});

/**
 * Cause of `readLoggerConfig` failing on `LOG_LEVEL=bogus`.
 */
const bogusLevelCause = async (): Promise<Cause.Cause<unknown>> => {
  const exit = await Effect.runPromiseExit(
    readLoggerConfig().pipe(
      Effect.provideService(
        ConfigProvider.ConfigProvider,
        ConfigProvider.fromEnv({ env: { LOG_LEVEL: 'bogus' } }),
      ),
    ),
  );
  if (Exit.isSuccess(exit)) {
    throw new Error('expected readLoggerConfig to fail');
  }

  return exit.cause;
};

describe('describeStartupFailure', () => {
  it('describes a config error as an invalid configuration', async () => {
    const text = describeStartupFailure(await bogusLevelCause());
    expect(text.startsWith('invalid configuration:')).toBe(true);
    expect(text).toContain('LOG_LEVEL');
  });

  it('redacts credentials in a config error message', () => {
    const error = new Config.ConfigError(
      new ConfigProvider.SourceError({ message: 'cannot read postgres://app:hunter2@db/main' }),
    );
    const text = describeStartupFailure(Cause.fail(error));
    expect(text.startsWith('invalid configuration:')).toBe(true);
    expect(text).not.toContain('hunter2');
  });

  it('describes any other failure as a failed start', () => {
    const text = describeStartupFailure(Cause.fail(new Error('db is down')));
    expect(text.startsWith('failed to start:')).toBe(true);
    expect(text).toContain('db is down');
  });

  it('reports every reason when a config error comes with another failure', () => {
    const configError = new Config.ConfigError(
      new ConfigProvider.SourceError({ message: 'missing EXAMPLE_URL' }),
    );
    const cause = Cause.combine(
      Cause.fail(configError),
      Cause.die(new Error('db down: postgres://u:db-secret@h/db')),
    );
    const text = describeStartupFailure(cause);
    expect(text.startsWith('failed to start:')).toBe(true);
    expect(text).toContain('db down');
    expect(text).not.toContain('db-secret');
  });

  it('does not throw on a foreign ConfigError-tagged value without a message', () => {
    const text = describeStartupFailure(Cause.fail({ _tag: 'ConfigError', reason: 'invalid' }));
    expect(text.startsWith('failed to start:')).toBe(true);
  });

  it('describes a Redactable ConfigError-tagged failure by its redacted form', () => {
    const hidden = {
      _tag: 'ConfigError',
      message: 'bad DATABASE_URL=raw-config-secret',
      [Redactable.symbolRedactable]: () => ({ _tag: 'ConfigError', message: 'hidden' }),
    };
    const text = describeStartupFailure(Cause.fail(hidden));
    expect(text).not.toContain('raw-config-secret');
    expect(text).toContain('hidden');
  });

  it('masks a credential in a span name of the failure', async () => {
    const exit = await Effect.runPromiseExit(
      Effect.fail(new StartupTestError({ message: 'boom' })).pipe(
        Effect.withSpan('connect postgres://app:span-pw@db/main'),
      ),
    );
    if (Exit.isSuccess(exit)) {
      throw new Error('expected a failure');
    }

    expect(describeStartupFailure(exit.cause)).not.toContain('span-pw');
  });

  it('redacts a bearer token in a die message', () => {
    const text = describeStartupFailure(
      Cause.die(new Error('upstream said Bearer abc123def456 was bad')),
    );
    expect(text.startsWith('failed to start:')).toBe(true);
    expect(text).not.toContain('abc123def456');
  });
});

/**
 * Runs a startup failure teardown on `exit` and returns the written lines and the exit code.
 */
const runTeardown = async (exit: Exit.Exit<unknown, unknown>) => {
  const lines: Array<string> = [];
  const teardown = makeStartupFailureTeardown((line) => {
    lines.push(line);
  });
  const code = await new Promise<number>((resolve) => {
    teardown(exit, resolve);
  });
  return { lines, code };
};

describe('makeStartupFailureTeardown', () => {
  it('writes one redacted line and exits 1 for a failure', async () => {
    const { lines, code } = await runTeardown(
      Exit.fail(new StartupTestError({ message: 'token Bearer abc123def456' })),
    );
    expect(code).toBe(1);
    expect(lines).toHaveLength(1);
    expect(lines[0]?.startsWith('failed to start:')).toBe(true);
    expect(lines[0]).not.toContain('abc123def456');
  });

  it('leaves success and interrupt-only exits to the default teardown', async () => {
    const success = await runTeardown(Exit.void);
    expect(success).toEqual({ lines: [], code: 0 });

    const interrupted = await runTeardown(Exit.failCause(Cause.interrupt()));
    expect(interrupted.lines).toEqual([]);
    expect(interrupted.code).not.toBe(1);
  });
});

describe('startup failures with custom redaction', () => {
  /**
   * Redaction that also masks `customerRef`.
   */
  const custom = { sensitiveKeys: ['customerRef'] };

  /**
   * Failure whose cause holds a key only the custom redaction knows.
   */
  const failure = Cause.fail(
    new Error('lookup failed', { cause: { customerRef: 'CUST-SECRET-42' } }),
  );

  it('masks configured keys when describing the failure', () => {
    expect(describeStartupFailure(failure)).toContain('CUST-SECRET-42');
    expect(describeStartupFailure(failure, custom)).not.toContain('CUST-SECRET-42');
  });

  it('passes the configured redaction through the exported teardown factory', () => {
    const lines: Array<string> = [];
    let code: number | undefined;
    const teardown = makeStartupFailureTeardownFromIndex((line) => lines.push(line), {
      redaction: custom,
    });
    teardown(Exit.failCause(failure), (exitCode) => {
      code = exitCode;
    });
    expect(code).toBe(1);
    expect(lines.join('\n')).not.toContain('CUST-SECRET-42');
  });

  it('still exits 1 when the failure value throws while it is read', () => {
    const hostile = {
      _tag: 'ConfigError',
      get message(): string {
        throw new Error('getter');
      },
    };
    let code: number | undefined;
    const teardown = makeStartupFailureTeardown(() => undefined);
    teardown(Exit.fail(hostile), (exitCode) => {
      code = exitCode;
    });
    expect(code).toBe(1);
  });
});
