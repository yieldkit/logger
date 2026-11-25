# Logging

## Level helpers

Each helper returns an `Effect<void>`. `fields` become annotations of that one line, and `undefined` values are dropped.

<!-- prettier-ignore -->
```ts
logTrace('cache.lookup', { key });                                    // hidden unless the level is Trace or All
logDebug('cache.miss', { key });                                      // hidden at the default Info
logInfo('item.sync.started', { attempt: 1 });
logWarning('item.sync.slow', { durationMs: 5200 });
logError('item.sync.skipped', { reason: 'locked' });                  // Error without a cause
logFailure('item.sync.failed', error, { attempt: 3 });                // Error, the error as a fail cause, plus its fields
logErrorCause('item.sync.crashed', cause);                            // Error with an existing Cause
logFatal('worker.stopped', cause, { exitCode: 1 });                   // cause and fields are optional
logWithFields('Warn', 'item.sync.slow', { durationMs: 5200 }, cause); // any level
```

`logFailure` adds `errorMessage`, `errorTag`, `errorName` and `errorStatus` (when the error has them) before your own fields, so yours win on a clash. It reads them when the effect runs, and reading never throws. `errorMessage` is the error's `message`, or its `_tag` for an object without one; an object with neither gets no `errorMessage`, and its fields appear redacted in `cause` and `error.message`.

A log call never fails because of what it logs. A value that cannot be read, such as a throwing getter or `toJSON`, or a revoked `Proxy`, is written as `[Unserializable]` (`UNSERIALIZABLE_LOG_VALUE`). A function is written as `[Function]`. If a logger installed by `LoggerLive`, `makeLoggerLayer` or `makeTestLogger` still cannot write a line (a line too large for `JSON.stringify`, say), it writes the message's string parts alone, without the cause, annotations and log spans, and drops the line when that fails too.

## Context

<!-- prettier-ignore -->
```ts
const sync = runSync.pipe(withLogContext({ itemId, cursor: undefined })); // every line inside gets itemId

const scoped = Effect.gen(function* () {
  yield* withLogContextScoped({ requestId });                             // until the Scope closes
  yield* logInfo('request.started');
});

compactLogFields({ a: 1, b: undefined });                                 // { a: 1 }
```

A field set of only `undefined` values adds nothing. Inside a span (`Effect.withSpan`), JSON and structured lines also carry `traceId` and `spanId`.

## Errors

<!-- prettier-ignore -->
```ts
extractErrorFields(new FetchError({ message: 'upstream 503', status: 503 }));
// { errorMessage: 'upstream 503', errorTag: 'FetchError', errorName: 'FetchError', errorStatus: 503 }

extractCauseSummary(cause); // { kind: 'fail' | 'die' | 'interrupt', message, tag?, name?, status?, fiberId? }
describeError(error);       // a message for any value; never throws
```

- `extractCauseSummary` picks the first fail, else the first die, else the first interrupt (message `Fiber interrupted`), and returns `undefined` for an empty cause. It is the `error` field of a JSON line.
- The message, tag and name of both functions are masked with `redactLogString`. `status` is copied from a finite numeric `status` property.
- `describeError` returns an `Error`'s `message` (or `name`), another object's `message` or `_tag`, or else the object's JSON with sensitive keys masked after its class name: `Credentials {"user":"u","password":"<redacted>"}`. It never calls the value's own `toString`. Its free text is not masked, so pass it through `redactLogString` before you store it.
