# Telemetry

The OTLP exporters live in their own entry point, so programs that only log don't load them or an HTTP client:

```ts
import { flushOtlp, telemetryLayer, tracingLayer } from '@yieldkit/logger/otlp';
```

`telemetryLayer(options: TelemetryOptions)` exports traces, metrics and logs over OTLP/HTTP and provides `OtlpExporter.Flusher`. It needs an `HttpClient`. `tracingLayer(serviceName, options?)` is the same layer with `serviceName` as the only required argument.

<!-- prettier-ignore -->
```ts
const TelemetryLive = telemetryLayer({
  serviceName: 'api',                                   // service.name; OTEL_SERVICE_NAME is ignored
  serviceVersion: '1.4.0',                              // optional; wins over OTEL_SERVICE_VERSION
  environment: 'production',                            // optional; defaults to NODE_ENV
  signals: { traces: true, metrics: true, logs: true }, // TelemetrySignals; each defaults to true
  serialization: 'protobuf',                            // default; 'json' is readable in tests
  headers: { 'x-api-key': apiKey },                     // optional; replaces the OTEL_*_HEADERS variables
  redaction: { sensitiveKeys: ['customerRef'] },        // optional; for span data
}).pipe(Layer.provide(BunHttpClient.layer));
```

Build it on top of the logger layer (`Layer.provideMerge(LoggerLive(...))`), so warnings from the exporters go through the redacted logger, and provide it to the whole program.

## Environment variables

A signal is exported only when it has an endpoint. Without any, the layer provides a `Flusher` that does nothing.

| Variable                                                 | Effect                                                               |
| -------------------------------------------------------- | -------------------------------------------------------------------- |
| `OTEL_EXPORTER_OTLP_ENDPOINT`                            | Base URL; `/v1/traces`, `/v1/metrics` and `/v1/logs` are appended    |
| `OTEL_EXPORTER_OTLP_{TRACES,METRICS,LOGS}_ENDPOINT`      | Per-signal URL, used as it is; wins over the base                    |
| `OTEL_EXPORTER_OTLP[_{TRACES,METRICS,LOGS}]_HEADERS`     | `key=value, key2=value2` request headers, trimmed, values decoded    |
| `OTEL_EXPORTER_OTLP[_{TRACES,METRICS,LOGS}]_COMPRESSION` | `gzip` or `none`                                                     |
| `OTEL_EXPORTER_OTLP[_{TRACES,METRICS,LOGS}]_TIMEOUT`     | Milliseconds to wait for the last export on shutdown                 |
| `OTEL_{TRACES,METRICS,LOGS}_EXPORTER`                    | Comma list; the signal is on when it is blank or includes `otlp`     |
| `OTEL_SDK_DISABLED`                                      | `true` (any case) turns every signal off; other values leave them on |
| `OTEL_SERVICE_VERSION`, `OTEL_RESOURCE_ATTRIBUTES`       | Resource attributes                                                  |
| `OTEL_EXPORTER_OTLP[_{TRACES,METRICS,LOGS}]_PROTOCOL`    | Ignored; export is always OTLP over HTTP                             |

A per-signal variable wins over the base one, and a blank one counts as unset. `signals.<signal>: false` turns a signal off whatever the environment says. An endpoint that is not an `http:` or `https:` URL, a compression other than `gzip` or `none`, or a timeout that is not a whole number fails the layer with a `ConfigError`.

Resource attributes: `serviceName` is always `service.name`. `serviceVersion` wins over `OTEL_SERVICE_VERSION`, which wins over `service.version` in `OTEL_RESOURCE_ATTRIBUTES`. A `deployment.environment.name` in `OTEL_RESOURCE_ATTRIBUTES` wins over `environment` and `NODE_ENV`.

## Traces

Spans are exported through `withTracerRedaction`: span and event names, attribute values, link attributes and the failure cause of a failed span are redacted before the exporter sees them. With `includeTracerLogger` (the default), each log line is also an event on the current span.

## Logs

Log records reach the exporter through the fan-out logger that `LoggerLive` and `makeLoggerLayer` install, after the logger's redaction and minimum level. So log export needs one of those layers, and only records logged by code the telemetry layer is provided to are exported: two runtimes in one process never share log exporters.

The exporters are added with `logExportSinkLayer`, which registers each sink under a context key of its own; `logExportSinkLayer(make)` adds your own sink logger next to them. Sink layers compose any way: merged as siblings (`Layer.mergeAll(TelemetryLive, CollectLive)`), chained with `Layer.provide`, or provided to one part of the program, where the sink only receives that part's records. Two runtimes never reach each other's sinks, even when they are built with one shared memo map. A list provided directly as `LogExportSinks` (a context reference) is used too:

```ts
import { logExportSinkLayer } from '@yieldkit/logger';
import { Effect, Logger } from 'effect';

const records: Array<unknown> = [];
const CollectLive = logExportSinkLayer(
  Effect.succeed(Logger.make((options) => records.push(options.message))),
);
```

A sink stops receiving records when its layer's scope closes, before the finalizers its `make` registered run. A sink that throws is skipped for that record; the other sinks and the logging effect carry on.

## Flushing

Closing the layer's scope flushes the last batches. To flush earlier, for example before a forced exit, run `flushOtlp`. It flushes the `OtlpExporter.Flusher` the layer provides and does nothing when there is none:

```ts
const flushed = flushOtlp.pipe(Effect.timeoutOption('2 seconds'));
```

Pass it to the crash handlers so a crash is exported before the process exits: `makeCrashHandlersLayer({ flush: flushOtlp })` (see [Crashes and startup failures](crash-and-startup.md)).

`flush` cannot wait for an export that was already running when it was called. Effect's exporter starts one on its own when a batch fills up (1,000 records), so a record that fills a batch right before a forced exit can be lost with that request.
