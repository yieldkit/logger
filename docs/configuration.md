# Configuration

`LoggerLive(defaults)` reads the environment and falls back to `defaults`. `makeLoggerLayer(options)` takes the same `LoggerLayerOptions` and never reads the environment, which suits tests and tools. Every option, with its default:

<!-- prettier-ignore -->
```ts
LoggerLive({
  service: undefined,        // `service` on JSON and structured lines
  version: undefined,        // `version` on JSON and structured lines
  env: 'development',        // NODE_ENV; `env` on JSON and structured lines, and what `auto` looks at
  format: 'auto',            // LOG_FORMAT: 'auto' | 'json' | 'structured' | 'pretty' | 'logfmt'
  minLevel: 'Info',          // LOG_LEVEL
  stderr: 'leveled',         // LOG_STDERR: 'leveled' | true | false
  colors: 'auto',            // LOG_COLORS: 'auto' | true | false; pretty only
  includeTracerLogger: true, // also write each line as an event on the current span
  maxLineBytes: 16 * 1024,   // DEFAULT_MAX_LINE_BYTES; JSON only, see formats.md
  redaction: undefined,      // { sensitiveKeys, allowKeys, scrubText }; see redaction.md
});
```

With `LoggerLive`, a variable that is set wins over the option you pass; the option is the fallback. `service`, `version`, `includeTracerLogger`, `maxLineBytes` and `redaction` are code only.

`minLevel` takes Effect's `LogLevel`, which is capitalised: `'All'`, `'Trace'`, `'Debug'`, `'Info'`, `'Warn'`, `'Error'`, `'Fatal'` or `'None'`. `LOG_LEVEL` accepts any case (see below).

`makeLoggerLayer` has no `development` default for `env`: without one, lines carry no `env` and `auto` picks `pretty`.

Both layers install the console logger, a redacted `Logger.tracerLogger` (unless `includeTracerLogger: false`), the fan-out logger that feeds OTLP log export (see [Telemetry](telemetry.md)) and the minimum level. `SilentLoggerLayer` sets the minimum level to `None` and drops every line.

## Environment variables

Values are trimmed and matched in any case.

| Variable     | Accepted                                                                                   | Default       |
| ------------ | ------------------------------------------------------------------------------------------ | ------------- |
| `LOG_LEVEL`  | `all`, `trace`, `debug`, `info`, `warn` or `warning`, `error`, `fatal`, `none` or `silent` | `info`        |
| `LOG_FORMAT` | `auto`, `json`, `structured`, `pretty`, `logfmt`                                           | `auto`        |
| `LOG_STDERR` | `leveled`; `true`, `yes`, `on`, `1`, `y`; `false`, `no`, `off`, `0`, `n`                   | `leveled`     |
| `LOG_COLORS` | `auto`; `true`, `yes`, `on`, `1`, `y`; `false`, `no`, `off`, `0`, `n`                      | `auto`        |
| `NODE_ENV`   | any non-empty string                                                                       | `development` |

`auto` resolves to `json` when the environment is `production` or `prod` (any case), and to `pretty` otherwise. Any other value of the first four fails `LoggerLive` with a `ConfigError` before a line is written. To print that error without the logger, see [Crashes and startup failures](crash-and-startup.md).

## Parsers

The parsers behind `LoggerLive` are exported for tools that read the same variables. Each returns `undefined` for an unknown spelling.

<!-- prettier-ignore -->
```ts
parseLogLevel('warning');                // 'Warn'
parseLogFormat('JSON');                  // 'json'
parseLogStderr('y');                     // true
parseLogColors('off');                   // false
resolveLogFormat('auto', 'prod');        // 'json'
resolveLogFormat('auto', 'staging');     // 'pretty'
readLoggerConfig({ service: 'worker' }); // Config<ResolvedLoggerConfig>, what LoggerLive reads
```
