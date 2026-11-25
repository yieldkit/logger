# Formats and line caps

| Format       | Output                                                         | `service`, `env`, `version`, `traceId`, `spanId` |
| ------------ | -------------------------------------------------------------- | ------------------------------------------------ |
| `json`       | One `StructuredLogRecord` per line, serialized and capped      | yes                                              |
| `structured` | The `StructuredLogRecord` object itself, passed to the console | yes                                              |
| `pretty`     | Effect's `Logger.consolePretty`, colored when `colors` allows  | no                                               |
| `logfmt`     | Effect's `Logger.formatLogFmt`                                 | no                                               |

`auto` picks `json` in production and `pretty` otherwise (see [Configuration](configuration.md)). Every format is redacted the same way.

## Streams

`stderr` decides where a line goes:

| `stderr`    | stderr                | stdout          |
| ----------- | --------------------- | --------------- |
| `'leveled'` | Warn, Error and Fatal | everything else |
| `true`      | every line            | nothing         |
| `false`     | nothing               | every line      |

The `json`, `structured` and `logfmt` formats write through Effect's `Console` service with `console.error` and `console.log` only, never `console.debug` or `console.info`. For `pretty`, the routing applies in terminal runtimes; in a browser, Effect's pretty logger always writes with `console.log`.

## The record

A JSON line is a `StructuredLogRecord`, and `error` is an `ErrorSummary`:

| Field                       | Content                                                           |
| --------------------------- | ----------------------------------------------------------------- |
| `timestamp`                 | ISO-8601 time                                                     |
| `level`                     | `TRACE`, `DEBUG`, `INFO`, `WARN`, `ERROR` or `FATAL`              |
| `service`, `env`, `version` | From the options, when set                                        |
| `message`                   | The log message, redacted                                         |
| `fiberId`                   | The fiber that logged, such as `#1`                               |
| `traceId`, `spanId`         | The current span, when there is one                               |
| `annotations`               | Log annotations and fields, redacted                              |
| `spans`                     | Open log spans and their elapsed milliseconds                     |
| `cause`                     | The pretty-printed cause, redacted, when the line has one         |
| `error`                     | `{ kind, message, tag?, name?, status?, fiberId? }` for the cause |
| `truncated`                 | `true` when the line was shortened                                |

`error` summarizes the first fail, else the first die, else the first interrupt (see [Logging](logging.md#errors)).

## Line cap

A JSON line longer than `maxLineBytes` (UTF-8, newline included; default `DEFAULT_MAX_LINE_BYTES`, 16 KiB) is shortened:

1. `truncated: true` is added.
2. `cause`, then `error.message`, then `message` is cut to the longest start that fits, ending in ` …[truncated]`. It stops as soon as the line fits.
3. If that is not enough, the line becomes a minimal record: `timestamp`, `level`, the identity and trace fields, the start of the message, `truncated` and the error's `kind`, `tag`, `name` and `status`.
4. Under a very small cap the minimal record drops `version`, `env`, `service`, `spanId` and `traceId` in that order. If it still doesn't fit, only `timestamp`, `level` and `truncated` are left. That record is about 80 bytes and is written even when the cap is smaller.

A `maxLineBytes` that is not a finite positive number (a `Number(process.env.X)` that came out `NaN`) uses the default. The other formats are not capped.

## Custom loggers

The builders below redact like the default logger and take the same `redaction` option:

<!-- prettier-ignore -->
```ts
import {
  makeConsoleLogger,
  makeJsonLogger,
  makeStructuredLogger,
  withConsoleRouting,
} from '@yieldkit/logger';
import { Logger } from 'effect';

makeStructuredLogger({ service: 'cli', env: 'production' });               // Logger<unknown, StructuredLogRecord>
makeJsonLogger({ service: 'cli', maxLineBytes: 8 * 1024 });                // Logger<unknown, string>, one capped line
makeConsoleLogger({ format: 'logfmt', stderr: 'leveled', colors: false }); // writes to the console

const CliLoggerLive = Logger.layer([withConsoleRouting(makeJsonLogger({ service: 'cli' }), 'leveled')]);
```

`makeConsoleLogger` and `withConsoleRouting` with `stderr` omitted or `false` follow Effect's `Logger.LogToStderr` reference; the layers set that reference themselves when `stderr` is a boolean.

A logger built straight from Effect's formatters is not redacted until you wrap it in `withRedaction` (see [Redaction](redaction.md#functions)).
