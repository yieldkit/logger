import { Data, Effect, Layer, Logger, Redactable, References } from 'effect';
import { Headers } from 'effect/http';
import { TestConsole } from 'effect/testing';
import { describe, expect, it } from 'vite-plus/test';

import {
  compactLogFields,
  logFailure,
  logInfo,
  withLogContext,
  withLogContextScoped,
} from './context.ts';
import { makeConsoleLogger, makeJsonLogger } from './formatters.ts';
import { captureLogs } from './testing/index.ts';

class UpstreamTestError extends Data.TaggedError('UpstreamTestError')<{
  readonly message: string;
  readonly status: number;
}> {}

describe('withLogContext', () => {
  it('ignores revoked fields when annotating an effect', async () => {
    const revoked = Proxy.revocable({ requestId: 'req-42' }, {});
    revoked.revoke();

    const program = logInfo('context').pipe(withLogContext(revoked.proxy));
    const { logs } = await Effect.runPromise(captureLogs(program));
    expect(logs[0]?.annotations).toEqual({});
  });

  it('ignores revoked fields when annotating a scope', async () => {
    const revoked = Proxy.revocable({ requestId: 'req-42' }, {});
    revoked.revoke();

    const annotateScope = withLogContextScoped(revoked.proxy);
    const program = Effect.scoped(Effect.andThen(annotateScope, logInfo('context')));
    const { logs } = await Effect.runPromise(captureLogs(program));
    expect(logs[0]?.annotations).toEqual({});
  });

  it('keeps scoped annotations inside the scope and applies the next annotation after it', async () => {
    const err = new UpstreamTestError({ message: 'Rate limited upstream', status: 429 });
    const { logs } = await Effect.runPromise(
      captureLogs(
        Effect.gen(function* () {
          yield* Effect.scoped(
            Effect.gen(function* () {
              yield* withLogContextScoped({ requestId: 'req-42' });
              yield* logFailure('upstream.request.failed', err, { source: 'example' });
            }),
          );
          yield* logInfo('after.scope').pipe(withLogContext({ component: 'api' }));
        }),
        { service: 'api' },
      ),
    );
    expect(logs).toHaveLength(2);
    expect(logs[0]?.level).toBe('ERROR');
    expect(logs[0]?.annotations).toEqual({
      requestId: 'req-42',
      source: 'example',
      errorMessage: 'Rate limited upstream',
      errorTag: 'UpstreamTestError',
      errorName: 'UpstreamTestError',
      errorStatus: 429,
    });
    expect(logs[0]?.error).toEqual({
      kind: 'fail',
      tag: 'UpstreamTestError',
      name: 'UpstreamTestError',
      message: 'Rate limited upstream',
      status: 429,
    });
    expect(logs[0]?.cause).toContain('UpstreamTestError');
    expect(logs[1]?.annotations).toEqual({ component: 'api' });
  });
});

/**
 * Callback whose source text holds a token, as a rejection that carries a handler might.
 */
const sourceCallback = (): string => 'Bearer fn-source-secret';

describe('root fields', () => {
  it('honours the redacted names of Effect Headers passed as the fields record', async () => {
    const headers = Headers.fromInput({ 'x-tenant-ref': 'TENANTSECRET9', accept: 'json' });
    const { logs } = await Effect.runPromise(
      captureLogs(logInfo('root', headers)).pipe(
        Effect.provideService(Headers.CurrentRedactedNames, ['x-tenant-ref']),
      ),
    );
    expect(logs[0]?.annotations).toEqual({ 'x-tenant-ref': '<redacted>', accept: 'json' });
  });

  it('honours the redacted names of Effect Headers passed as log annotations', async () => {
    const headers = Headers.fromInput({ 'x-tenant-ref': 'TENANTSECRET9', accept: 'json' });
    const { logs } = await Effect.runPromise(
      captureLogs(
        logInfo('annotated').pipe(Effect.provideService(References.CurrentLogAnnotations, headers)),
      ).pipe(Effect.provideService(Headers.CurrentRedactedNames, ['x-tenant-ref'])),
    );
    expect(logs[0]?.annotations).toEqual({ 'x-tenant-ref': '<redacted>', accept: 'json' });
  });

  it('describes a function passed to logFailure without its source', async () => {
    const { logs } = await Effect.runPromise(captureLogs(logFailure('op failed', sourceCallback)));
    expect(JSON.stringify(logs)).not.toContain('fn-source-secret');
    expect(logs[0]?.annotations['errorMessage']).toBe('[Function]');
  });

  it('logs the redacted form of a Redactable error passed to logFailure', async () => {
    /**
     * Error that hides its message through Effect's `Redactable` protocol.
     */
    class OpaqueError extends Error {
      /**
       * The form logged in place of this error.
       */
      [Redactable.symbolRedactable]() {
        return { name: 'OpaqueError', message: 'hidden' };
      }
    }

    const { logs } = await Effect.runPromise(
      captureLogs(logFailure('op failed', new OpaqueError('xK9opaqueCRED77'))),
    );
    expect(JSON.stringify(logs)).not.toContain('xK9opaqueCRED77');
    expect(logs[0]?.annotations['errorMessage']).toBe('hidden');
  });

  it('masks a plain-object error under a configured sensitive key on every sink', async () => {
    const redaction = { sensitiveKeys: ['customerRef'] };
    const lines: Array<string> = [];
    const json = Logger.map(makeJsonLogger({ redaction }), (line) => {
      lines.push(line);
    });
    const failure = logFailure('charge.failed', { customerRef: 'CUST-42', reason: 'declined' });
    await Effect.runPromise(failure.pipe(Effect.provide(Logger.layer([json]))));
    const logfmt = await Effect.runPromise(
      Effect.gen(function* () {
        yield* failure;
        return [...(yield* TestConsole.logLines), ...(yield* TestConsole.errorLines)];
      }).pipe(
        Effect.provide(
          Layer.mergeAll(
            Logger.layer([makeConsoleLogger({ format: 'logfmt', redaction })]),
            TestConsole.layer,
          ),
        ),
      ),
    );
    const { logs } = await Effect.runPromise(captureLogs(failure, { redaction }));
    expect(lines).toHaveLength(1);
    expect(logfmt).toHaveLength(1);
    expect(JSON.stringify([logs, lines, logfmt])).not.toContain('CUST-42');
    expect(logs[0]?.annotations).not.toHaveProperty('errorMessage');
    expect(logs[0]?.cause).toContain('"customerRef":"<redacted>"');
  });

  it('turns a throwing top-level getter into an unserializable field instead of throwing', async () => {
    const fields = {
      ok: 1,
      get broken(): never {
        throw new Error('getter-top');
      },
    };
    const { logs } = await Effect.runPromise(captureLogs(logInfo('hostile', fields)));
    expect(logs[0]?.annotations).toEqual({ ok: 1, broken: '[Unserializable]' });
    expect(compactLogFields(fields)).toEqual({ ok: 1, broken: '[Unserializable]' });
  });
});
