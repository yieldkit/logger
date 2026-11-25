# Testing

`@yieldkit/logger/testing` collects structured records in memory instead of writing them to the console. Records are redacted exactly like console output, so assert on `<redacted>`, not on the secret.

## One effect

`captureLogs(effect, options?)` runs `effect` with a fresh logger and returns its value and a copy of the records:

```ts
import { captureLogs } from '@yieldkit/logger/testing';
import { Effect } from 'effect';
import { expect, it } from 'vite-plus/test';

it('logs the item id on every line', async () => {
  const { logs } = await Effect.runPromise(captureLogs(syncItem('a1')));

  expect(logs[0]?.annotations).toEqual({ itemId: 'a1', attempt: 1 });
  expect(logs[1]?.error).toMatchObject({ kind: 'fail', tag: 'FetchError', status: 503 });
});
```

## A logger that outlives one effect

`makeTestLogger(options?)` returns a `TestLoggerHarness` (the logger, a layer and its records) for a layer built once per suite:

```ts
import { makeTestLogger } from '@yieldkit/logger/testing';
import { Effect } from 'effect';
import { beforeEach, expect, it } from 'vite-plus/test';

const logs = makeTestLogger({ minLevel: 'Debug', service: 'test' });

beforeEach(() => logs.clear());

it('logs the retry', async () => {
  await Effect.runPromise(program.pipe(Effect.provide(logs.layer)));
  expect(logs.records.map((record) => record.message)).toContain('item.sync.retry');
});
```

| Member    | Content                                                                |
| --------- | ---------------------------------------------------------------------- |
| `records` | Records captured since the last `clear`, in order; updated in place    |
| `layer`   | Installs the logger and, when set, the minimum level                   |
| `context` | The same as a `Context`, for `Effect.provide` without building a layer |
| `logger`  | The `Logger` that appends to `records`                                 |
| `clear`   | Empties `records`; the layer stays installed                           |

## Options

Both functions take `TestLoggerOptions`:

| Option                      | Default         | Purpose                                               |
| --------------------------- | --------------- | ----------------------------------------------------- |
| `minLevel`                  | Effect's (Info) | Lowest level captured                                 |
| `includeTracerLogger`       | `true`          | Also install the redacted tracer logger (span events) |
| `service`, `env`, `version` | none            | Written on each record                                |
| `redaction`                 | none            | Extra key names, as in [Redaction](redaction.md)      |

The test logger replaces the current loggers, so nothing reaches the console or the OTLP log exporter while it is installed.
