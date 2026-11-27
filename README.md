# @yieldkit/logger

[![npm](https://img.shields.io/npm/v/@yieldkit/logger)](https://www.npmjs.com/package/@yieldkit/logger)
[![CI](https://github.com/yieldkit/logger/actions/workflows/ci.yml/badge.svg)](https://github.com/yieldkit/logger/actions/workflows/ci.yml)
[![license](https://img.shields.io/npm/l/@yieldkit/logger)](LICENSE)

Structured logging for Effect programs: JSON, logfmt or pretty console lines with secrets masked, and optional OTLP export of traces, metrics and logs.

Every output goes through the same redaction: console lines, span events, exported logs and spans, and test records. A `password` field, a `Bearer` token or the credentials in a URL are written as `<redacted>`.

## Install

```bash
pnpm add @yieldkit/logger effect
```

`effect` 4.1.7 or a later 4.1 patch is a peer dependency. Redaction relies on Effect internals, so a new Effect minor version needs a release of this package.

| Import                     | Contents                                                                |
| -------------------------- | ----------------------------------------------------------------------- |
| `@yieldkit/logger`         | Loggers, redaction, crash handlers, metrics helpers and request ids     |
| `@yieldkit/logger/otlp`    | `telemetryLayer`, `tracingLayer` and `flushOtlp`; needs an `HttpClient` |
| `@yieldkit/logger/testing` | `captureLogs` and `makeTestLogger` for tests                            |

A program that only logs never loads the OTLP exporters or an HTTP client. The examples provide the `HttpClient` with `BunHttpClient` from `@effect/platform-bun`, which you add yourself.

## Quick start

```ts
import { BunHttpClient, BunRuntime } from '@effect/platform-bun';
import {
  LoggerLive,
  logFailure,
  logInfo,
  makeCrashHandlersLayer,
  startupFailureTeardown,
  withLogContext,
} from '@yieldkit/logger';
import { flushOtlp, tracingLayer } from '@yieldkit/logger/otlp';
import { Data, Effect, Layer } from 'effect';

class FetchError extends Data.TaggedError('FetchError')<{ message: string; status: number }> {}

const syncItem = (itemId: string) =>
  Effect.gen(function* () {
    yield* logInfo('item.sync.started', { attempt: 1, cursor: undefined });
    yield* logFailure('item.sync.failed', new FetchError({ message: 'upstream 503', status: 503 }));
  }).pipe(withLogContext({ itemId }));

const ObservabilityLive = tracingLayer('worker').pipe(
  Layer.provide(BunHttpClient.layer),
  Layer.provideMerge(LoggerLive({ service: 'worker' })),
);

syncItem('a1').pipe(
  Effect.provide(
    makeCrashHandlersLayer({ flush: flushOtlp }).pipe(Layer.provideMerge(ObservabilityLive)),
  ),
  BunRuntime.runMain({ disableErrorReporting: true, teardown: startupFailureTeardown }),
);
```

In development the format is `pretty`:

```text
[20:32:56.597] INFO (#1): item.sync.started
  itemId: a1
  attempt: 1
[20:32:56.604] ERROR (#1): item.sync.failed
  FetchError: upstream 503
      at <anonymous> (src/main.ts:12:47)
  itemId: a1
  errorMessage: upstream 503
  errorTag: FetchError
  errorName: FetchError
  errorStatus: 503
```

With `NODE_ENV=production` each line is one JSON record; see [Formats](docs/formats.md#the-record).

`cursor: undefined` is dropped, `withLogContext` puts `itemId` on both lines, and `logFailure` adds the error's fields and a summary in `error`.

```ts
import { CrashHandlersLive, LoggerLive } from '@yieldkit/logger';
import { Layer } from 'effect';

// No OTLP: crash handlers built on the logger, so crash lines are redacted.
const MainLive = CrashHandlersLive.pipe(Layer.provideMerge(LoggerLive({ service: 'worker' })));
```

`tracingLayer` exports only when an `OTEL_EXPORTER_OTLP_*ENDPOINT` is set.

## Common tasks

### Add context and trace ids to every line

```ts
import { logInfo, withLogContext } from '@yieldkit/logger';
import { Effect } from 'effect';

const createOrder = logInfo('order.created', {
  orderId: 'o-42',
  totalCents: 4200,
  coupon: undefined,
}).pipe(Effect.withSpan('order.create'), withLogContext({ requestId: 'req-7f3a' }));
```

```json
{
  "timestamp": "2026-11-25T19:32:56.363Z",
  "level": "INFO",
  "service": "worker",
  "env": "production",
  "message": "order.created",
  "fiberId": "#1",
  "traceId": "6f6f8a9c270275944c844b79ebcb529f",
  "spanId": "dbc7169ca0d8cc82",
  "annotations": { "requestId": "req-7f3a", "orderId": "o-42", "totalCents": 4200 },
  "spans": {}
}
```

Use `withLogContextScoped` instead to keep the context until a `Scope` closes.

### Keep secrets out of logs

```ts
import { logInfo } from '@yieldkit/logger';
import { Redacted } from 'effect';

const connect = logInfo('db.connect', {
  url: 'postgres://app:hunter2@db:5432/main',
  password: 'hunter2',
  stripe: Redacted.make('sk_live_123'),
  headers: { authorization: 'Bearer eyJhbGciOi', accept: 'application/json' },
  tokenCount: 1200,
});
```

The logged line, without the standard fields (`timestamp`, `level` and the rest):

```json
{
  "message": "db.connect",
  "annotations": {
    "url": "postgres://<redacted>@db:5432/main",
    "password": "<redacted>",
    "stripe": "<redacted>",
    "headers": { "authorization": "<redacted>", "accept": "application/json" },
    "tokenCount": 1200
  }
}
```

| Masked                                                         | How                                                    |
| -------------------------------------------------------------- | ------------------------------------------------------ |
| `Redacted` and `Redactable` values                             | Always, under any key                                  |
| Values under keys like `password`, `token`, `cookie`, `apiKey` | Always; numbers and booleans under built-in names stay |
| URL credentials, `Bearer`/`Basic` tokens, `?sig=` and similar  | In any string, as a convenience                        |
| Your own key names and patterns                                | `redaction: { sensitiveKeys, allowKeys, scrubText }`   |

A secret written into prose (`"password=x"`) or under an innocent key (`{ value: 'sk-live-abc' }`) is not caught. See [Redaction](docs/redaction.md).

### Propagate request ids

```ts
import { requestIdFromHeaders, withLogContext } from '@yieldkit/logger';

const requestId = requestIdFromHeaders(request.headers); // x-request-id when valid, else a new UUID
const handled = handle(request).pipe(withLogContext({ requestId }));
```

An id longer than 128 characters or containing anything other than letters, digits and `_.:=-` is replaced, so a header can't inject log lines. See [Durations and request ids](docs/durations-and-request-ids.md).

### Assert on logs in tests

```ts
import { captureLogs } from '@yieldkit/logger/testing';
import { Effect } from 'effect';
import { expect } from 'vite-plus/test';

const { logs } = await Effect.runPromise(captureLogs(syncItem('a1')));

expect(logs[0]?.annotations).toEqual({ itemId: 'a1', attempt: 1 });
expect(logs[1]?.error).toMatchObject({ kind: 'fail', tag: 'FetchError', status: 503 });
```

Records are redacted like console output and nothing reaches the console. For a logger shared across a suite, use `makeTestLogger`. See [Testing](docs/testing.md).

### Time an effect

```ts
import { durationHistogram, recordDurationMs } from '@yieldkit/logger';

const queryMs = durationHistogram('db_query_ms', 'Time spent in one query');
const timed = runQuery.pipe(recordDurationMs(queryMs));
```

The duration is recorded in milliseconds on success, failure and interruption.

## What it does

| Area          | API                                                                     | Details                                                                      | Docs                                                           |
| ------------- | ----------------------------------------------------------------------- | ---------------------------------------------------------------------------- | -------------------------------------------------------------- |
| Logging       | `logInfo`, `logFailure`, `logWarning`, … `withLogContext`               | Field objects, `undefined` dropped, context on every line inside an effect   | [Logging](docs/logging.md)                                     |
| Configuration | `LoggerLive`, `makeLoggerLayer`                                         | `LoggerLive` reads `LOG_*` and `NODE_ENV`; `makeLoggerLayer` is code only    | [Configuration](docs/configuration.md)                         |
| Formats       | `json`, `structured`, `pretty`, `logfmt`                                | JSON lines carry trace and span ids and are capped at 16 KiB                 | [Formats and line caps](docs/formats.md)                       |
| Redaction     | `redaction` option, `redactLogValue`                                    | Sensitive keys, `Redacted` values and credential shapes in text              | [Redaction](docs/redaction.md)                                 |
| Telemetry     | `telemetryLayer`, `tracingLayer`, `flushOtlp`                           | Traces, metrics and logs over OTLP/HTTP, configured by `OTEL_*` variables    | [Telemetry](docs/telemetry.md)                                 |
| Crashes       | `CrashHandlersLive`, `makeCrashHandlersLayer`, `startupFailureTeardown` | Fatal line and exit on uncaught errors; one redacted line on startup failure | [Crashes and startup failures](docs/crash-and-startup.md)      |
| Callbacks     | `makeCallbackLogger`                                                    | Logs from event emitters and other code outside a fiber                      | [Callback logger](docs/callback-logger.md)                     |
| Metrics, ids  | `durationHistogram`, `recordDurationMs`, `requestIdFromHeaders`         | Millisecond histograms; validated `x-request-id`                             | [Durations and request ids](docs/durations-and-request-ids.md) |
| Testing       | `captureLogs`, `makeTestLogger`                                         | Redacted records in memory                                                   | [Testing](docs/testing.md)                                     |

## Options

`LoggerLive` reads `LOG_LEVEL`, `LOG_FORMAT`, `LOG_STDERR`, `LOG_COLORS` and `NODE_ENV`, falling back to the options you pass. Every option and accepted spelling is in [Configuration](docs/configuration.md).

## Development

```bash
pnpm install
pnpm check   # format, lint and types
pnpm test
```

See [CONTRIBUTING.md](CONTRIBUTING.md) before opening a pull request.

## License

[MIT](LICENSE)
