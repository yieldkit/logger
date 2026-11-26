import type { HttpClient } from 'effect/http';

import { Config, Duration, Effect, Layer, Option, Schema, Tracer } from 'effect';
import {
  OtlpExporter,
  OtlpLogger,
  OtlpMetrics,
  OtlpSerialization,
  OtlpTracer,
} from 'effect/observability';

import type { RedactionOptions } from '../credentials.ts';
import type { LogRedaction } from '../redact.ts';

import { resolveRedaction } from '../formatters.ts';
import { logExportSinkLayer } from '../log-fan-out.ts';

/**
 * Signals that `telemetryLayer` can export. Setting one to `false` turns it off whatever the
 * environment says. A missing entry counts as `true`.
 */
export type TelemetrySignals = {
  /**
   * Exports spans. Defaults to `true`.
   */
  readonly traces?: boolean;

  /**
   * Exports Effect metrics. Defaults to `true`.
   */
  readonly metrics?: boolean;

  /**
   * Exports log records. Defaults to `true`. Records only reach the exporter when `LoggerLive` or
   * `makeLoggerLayer` is installed, and only from the code this layer is provided to.
   */
  readonly logs?: boolean;
};

/**
 * Options for `telemetryLayer`.
 */
export type TelemetryOptions = {
  /**
   * `service.name` on the exported resource. It always takes precedence over `OTEL_SERVICE_NAME`,
   * which is therefore ignored. An empty name fails with `ConfigError` when metrics are exported.
   */
  readonly serviceName: string;

  /**
   * `service.version` on the exported resource. When omitted, `OTEL_SERVICE_VERSION` or
   * `service.version` in `OTEL_RESOURCE_ATTRIBUTES` is used.
   */
  readonly serviceVersion?: string;

  /**
   * `deployment.environment.name` on the exported resource. Defaults to `NODE_ENV`. A value in
   * `OTEL_RESOURCE_ATTRIBUTES` always wins over both.
   */
  readonly environment?: string;

  /**
   * Turns individual signals off in code. Every signal is on by default.
   */
  readonly signals?: TelemetrySignals;

  /**
   * OTLP/HTTP body encoding. Defaults to `protobuf`. `json` is readable, which helps in tests.
   */
  readonly serialization?: 'protobuf' | 'json';

  /**
   * HTTP headers sent with every export request, such as a collector API key. When set, they
   * replace `OTEL_EXPORTER_OTLP_<SIGNAL>_HEADERS` and `OTEL_EXPORTER_OTLP_HEADERS`.
   */
  readonly headers?: Readonly<Record<string, string>>;

  /**
   * Redaction options (extra sensitive and allowed names, `scrubText`) used when span names,
   * attributes, events and failure causes are redacted. Log records are redacted by the logger
   * layer with its own `redaction` option, so pass the same value to both.
   */
  readonly redaction?: RedactionOptions;
};

/**
 * One exported signal, named as in its default `/v1/<signal>` collector path.
 */
type Signal = 'traces' | 'metrics' | 'logs';

/**
 * The resource passed to Effect's OTLP exporters, which merge it with the OTEL_* variables.
 */
type TelemetryResource = {
  /**
   * `service.name`, taken from `TelemetryOptions.serviceName`.
   */
  readonly serviceName: string;

  /**
   * `service.version`. Absent rather than `undefined` when not set in code, so the env value wins.
   */
  readonly serviceVersion?: string;

  /**
   * Extra resource attributes set in code. They override `OTEL_RESOURCE_ATTRIBUTES`.
   */
  readonly attributes: Readonly<Record<string, string>>;
};

/**
 * Per-signal exporter settings read from the OTEL_* variables, passed to Effect's OTLP exporters.
 */
type ExportSettings = {
  /**
   * Request headers, or `undefined` for none.
   */
  readonly headers: Readonly<Record<string, string>> | undefined;

  /**
   * Request body compression, or `undefined` for Effect's default (`none`).
   */
  readonly compression: 'gzip' | 'none' | undefined;

  /**
   * Longest wait for the last export when the layer closes, or `undefined` for Effect's default.
   */
  readonly shutdownTimeout: Duration.Duration | undefined;
};

/**
 * Resource attribute that names the deployment environment.
 */
const ENVIRONMENT_ATTRIBUTE = 'deployment.environment.name';

/**
 * Exporter name that sends a signal over OTLP.
 */
const EXPORTER_OTLP = 'otlp';

/**
 * Separator between the entries of an `OTEL_<SIGNAL>_EXPORTER` list.
 */
const EXPORTER_LIST_SEPARATOR = ',';

/**
 * `OTEL_SDK_DISABLED` value, in any case, that turns every signal off. Any other value leaves them
 * on, as the OpenTelemetry specification says.
 */
const SDK_DISABLED_VALUE = 'true';

/**
 * `OTEL_EXPORTER_OTLP_*_TIMEOUT` text: blank or a whole number of milliseconds.
 */
const TIMEOUT_PATTERN = /^\s*\d*\s*$/;

/**
 * Parses an `OTEL_EXPORTER_OTLP_*_COMPRESSION` value in any case. Blank is unset; anything other
 * than `gzip` or `none` returns `undefined`.
 */
const parseCompression = (raw: string): Option.Option<'gzip' | 'none'> | undefined => {
  const value = raw.trim().toLowerCase();
  if (value === '') {
    return Option.none();
  }

  if (value === 'gzip' || value === 'none') {
    return Option.some(value);
  }

  return undefined;
};

/**
 * `OTEL_EXPORTER_OTLP_*_COMPRESSION` text that {@link parseCompression} accepts.
 */
const CompressionText = Schema.String.check(
  Schema.makeFilter((value) => parseCompression(value) !== undefined, {
    message: 'Expected gzip or none',
  }),
);

/**
 * `OTEL_EXPORTER_OTLP_*_TIMEOUT` text: blank or whole milliseconds.
 */
const TimeoutText = Schema.String.check(
  Schema.makeFilter((value) => TIMEOUT_PATTERN.test(value), {
    message: 'Expected a whole number of milliseconds',
  }),
);

/**
 * Trailing slash, if any, at the end of a base collector path, replaced by `/v1/<signal>`.
 */
const TRAILING_SLASH_PATTERN = /\/?$/;

/**
 * Collector URL that must use `http:` or `https:`.
 */
const HttpEndpoint = Schema.URLFromString.check(
  Schema.makeFilter((url) => url.protocol === 'http:' || url.protocol === 'https:', {
    message: 'Expected an HTTP or HTTPS collector URL',
  }),
);

/**
 * Empty string or an HTTP(S) collector URL. A blank env var stays empty.
 */
const OptionalEndpoint = Schema.Trim.pipe(
  Schema.decodeTo(Schema.Union([Schema.Literal(''), HttpEndpoint])),
);

/**
 * Exports traces, metrics and logs over OTLP/HTTP to the collector named by the OTEL_* variables,
 * and provides the `OtlpExporter.Flusher` shared by all three. Closing the layer's scope flushes
 * the last batches.
 *
 * - `OTEL_SDK_DISABLED=true` (any case) turns every signal off.
 * - Each signal uses `OTEL_EXPORTER_OTLP_<SIGNAL>_ENDPOINT` as is, or `OTEL_EXPORTER_OTLP_ENDPOINT`
 *   with `/v1/<signal>` appended. With neither set, the signal is off.
 * - `OTEL_<SIGNAL>_EXPORTER` is a comma-separated list; the signal is on when the list is blank or
 *   includes `otlp` (`otlp,console` keeps it on, `none` turns it off). `signals.<signal>: false`
 *   turns it off whatever the environment says.
 * - Requests carry `OTEL_EXPORTER_OTLP_<SIGNAL>_HEADERS` or `OTEL_EXPORTER_OTLP_HEADERS`
 *   (`key=value,key2=value2`, values percent-decoded) unless `headers` is set, use
 *   `OTEL_EXPORTER_OTLP[_<SIGNAL>]_COMPRESSION` (`gzip` or `none`), and wait at most
 *   `OTEL_EXPORTER_OTLP[_<SIGNAL>]_TIMEOUT` milliseconds for the last export on shutdown.
 *
 * Log records reach the exporter through the fan-out logger installed by `LoggerLive` and
 * `makeLoggerLayer`, after the logger's redaction, so log export needs one of them, and only
 * records logged by code this layer is provided to are exported. The current loggers are not
 * replaced. With every signal off, the layer provides a `Flusher` whose `flush` does nothing. An
 * enabled signal with an endpoint that is not an HTTP(S) URL, a compression other than `gzip` or
 * `none`, or a timeout that is not an integer fails with `ConfigError`. An empty service name also
 * fails with `ConfigError` when metrics are exported.
 */
export const telemetryLayer = (
  options: TelemetryOptions,
): Layer.Layer<OtlpExporter.Flusher, Config.ConfigError, HttpClient.HttpClient> =>
  Layer.unwrap(
    Effect.gen(function* () {
      const disabled = yield* Config.String('OTEL_SDK_DISABLED').pipe(
        Config.withDefault(''),
        Config.map((value) => value.trim().toLowerCase() === SDK_DISABLED_VALUE),
      );
      if (disabled) {
        return OtlpExporter.layerFlusher;
      }

      const base = optionalEndpoint('OTEL_EXPORTER_OTLP_ENDPOINT');
      const traces = yield* signalEndpoint('traces', base, options.signals);
      const metrics = yield* signalEndpoint('metrics', base, options.signals);
      const logs = yield* signalEndpoint('logs', base, options.signals);
      if (traces === undefined && metrics === undefined && logs === undefined) {
        return OtlpExporter.layerFlusher;
      }

      const resource = yield* resolveResource(options);
      const redaction = resolveRedaction(options.redaction);
      const traceExport =
        traces === undefined
          ? OtlpExporter.layerFlusher
          : tracesLayer(traces, resource, yield* exportSettings('traces', options), redaction);
      if (metrics !== undefined) {
        const validateServiceName = Schema.decodeEffect(Schema.NonEmptyString)(
          options.serviceName,
        ).pipe(Effect.mapError((error) => new Config.ConfigError(error)));
        yield* validateServiceName;
      }

      const metricExport =
        metrics === undefined
          ? OtlpExporter.layerFlusher
          : metricsLayer(metrics, resource, yield* exportSettings('metrics', options));
      const logExport =
        logs === undefined
          ? OtlpExporter.layerFlusher
          : logsLayer(logs, resource, yield* exportSettings('logs', options));
      const signals = Layer.mergeAll(traceExport, metricExport, logExport);
      return signals.pipe(Layer.provide(serializationLayer(options.serialization)));
    }),
  );

/**
 * Reads `key` as an optional collector URL. A missing variable is an empty string.
 */
const optionalEndpoint = (key: string) =>
  Config.schema(OptionalEndpoint, key).pipe(Config.withDefault('' as const));

/**
 * Tells whether the `OTEL_<SIGNAL>_EXPORTER` list allows the signal: it is missing or blank, or one
 * of its comma-separated entries is `otlp` (any case).
 */
const exporterEnabled = (signal: Signal) =>
  Config.String(`OTEL_${signal.toUpperCase()}_EXPORTER`).pipe(
    Config.withDefault(''),
    Config.map((value) => {
      const names = value
        .split(EXPORTER_LIST_SEPARATOR)
        .map((name) => name.trim().toLowerCase())
        .filter((name) => name !== '');
      return names.length === 0 || names.includes(EXPORTER_OTLP);
    }),
  );

/**
 * Reads an OTEL_* header list (`key=value,key2=value2`, values percent-decoded). Whitespace around
 * each name and value is dropped, as the OpenTelemetry list format allows (`a=1, b=2`).
 */
const headersConfig = (key: string) =>
  Config.Record(Schema.String, Schema.StringFromUriComponent, key, { trim: true });

/**
 * Reads a compression variable. Blank is unset.
 */
const compressionConfig = (key: string): Config.Config<Option.Option<'gzip' | 'none'>> =>
  Config.schema(CompressionText, key).pipe(
    Config.map((raw) => parseCompression(raw) ?? Option.none()),
  );

/**
 * Reads a timeout variable in milliseconds. Blank is unset.
 */
const timeoutConfig = (key: string): Config.Config<Option.Option<number>> =>
  Config.schema(TimeoutText, key).pipe(
    Config.map((raw) => (raw.trim() === '' ? Option.none() : Option.some(Number(raw.trim())))),
  );

/**
 * Reads a header list. Blank is unset.
 */
const headersOptionConfig = (
  key: string,
): Config.Config<Option.Option<Readonly<Record<string, string>>>> =>
  Config.String(key).pipe(
    Config.withDefault(''),
    Config.flatMap((raw) =>
      raw.trim() === ''
        ? Config.succeed(Option.none())
        : headersConfig(key).pipe(Config.map(Option.some)),
    ),
  );

/**
 * Reads the signal's variable `OTEL_EXPORTER_OTLP_<SIGNAL>_<SUFFIX>`, falling back to
 * `OTEL_EXPORTER_OTLP_<SUFFIX>`. A missing or blank variable counts as unset.
 */
const signalOrBase = <A>(
  signal: Signal,
  suffix: string,
  read: (key: string) => Config.Config<Option.Option<A>>,
): Config.Config<Option.Option<A>> =>
  Config.all({
    specific: Config.option(read(`OTEL_EXPORTER_OTLP_${signal.toUpperCase()}_${suffix}`)),
    base: Config.option(read(`OTEL_EXPORTER_OTLP_${suffix}`)),
  }).pipe(
    Config.map(({ specific, base }) =>
      Option.orElse(Option.flatten(specific), () => Option.flatten(base)),
    ),
  );

/**
 * Reads the headers, compression and shutdown timeout of one signal. `options.headers` wins over
 * the header variables.
 */
const exportSettings = Effect.fnUntraced(function* (signal: Signal, options: TelemetryOptions) {
  const headers =
    options.headers ??
    Option.getOrUndefined(yield* signalOrBase(signal, 'HEADERS', headersOptionConfig));
  const compression = yield* signalOrBase(signal, 'COMPRESSION', compressionConfig);
  const timeout = yield* signalOrBase(signal, 'TIMEOUT', timeoutConfig);
  const settings: ExportSettings = {
    headers,
    compression: Option.getOrUndefined(compression),
    shutdownTimeout: Option.getOrUndefined(Option.map(timeout, (ms) => Duration.millis(ms))),
  };
  return settings;
});

/**
 * Resolves the collector URL for one signal, or `undefined` when the signal is off in code, set to
 * `none`, or has no endpoint. The signal endpoint is used as is; otherwise `/v1/<signal>` replaces
 * the trailing slash of a copy of `base`. `base` is read only when the signal has no endpoint of
 * its own, so an invalid base URL fails only when an enabled signal falls back to it.
 */
const signalEndpoint = Effect.fnUntraced(function* (
  signal: Signal,
  base: Config.Config<URL | ''>,
  signals: TelemetrySignals | undefined,
) {
  if (signals?.[signal] === false) {
    return undefined;
  }

  const enabled = yield* exporterEnabled(signal);
  if (!enabled) {
    return undefined;
  }

  const specific = yield* optionalEndpoint(`OTEL_EXPORTER_OTLP_${signal.toUpperCase()}_ENDPOINT`);
  if (specific !== '') {
    return specific.href;
  }

  const baseUrl = yield* base;
  if (baseUrl === '') {
    return undefined;
  }

  const url = new URL(baseUrl.href);
  url.pathname = url.pathname.replace(TRAILING_SLASH_PATTERN, `/v1/${signal}`);
  return url.href;
});

/**
 * Builds the resource from `options`. `deployment.environment.name` comes from
 * `options.environment` or `NODE_ENV`, and is left out when `OTEL_RESOURCE_ATTRIBUTES` already sets
 * it, because explicit attributes would otherwise override the operator's value. Keys that have no
 * value are left out so they never shadow the OTEL_* variables.
 */
const resolveResource = Effect.fnUntraced(function* (options: TelemetryOptions) {
  const nodeEnv = yield* Config.String('NODE_ENV').pipe(Config.withDefault(''));
  const environment = options.environment ?? (nodeEnv.trim() === '' ? undefined : nodeEnv);
  const operatorAttributes = yield* Config.Record(
    Schema.StringFromUriComponent,
    Schema.StringFromUriComponent,
    'OTEL_RESOURCE_ATTRIBUTES',
    { trim: true, keepEmptyValues: true },
  ).pipe(Config.withDefault(undefined));
  const operatorSetEnvironment =
    operatorAttributes !== undefined && Object.hasOwn(operatorAttributes, ENVIRONMENT_ATTRIBUTE);
  const attributes: Record<string, string> = {};
  if (environment !== undefined && !operatorSetEnvironment) {
    attributes[ENVIRONMENT_ATTRIBUTE] = environment;
  }

  const resource: TelemetryResource = { serviceName: options.serviceName, attributes };
  if (options.serviceVersion === undefined) {
    return resource;
  }

  return { ...resource, serviceVersion: options.serviceVersion };
});

/**
 * Exports spans to `url` through a redacting tracer. Effect's OTLP tracer renders a failed span's
 * cause into its status message and `exception` events without going through a logger, so the
 * tracer itself sanitizes exit causes and attributes.
 */
const tracesLayer = (
  url: string,
  resource: TelemetryResource,
  settings: ExportSettings,
  redaction: LogRedaction,
) => {
  const tracer = OtlpTracer.make({ url, resource, ...settings }).pipe(
    Effect.map(redaction.withTracerRedaction),
  );
  return Layer.effect(Tracer.Tracer, tracer).pipe(Layer.provideMerge(OtlpExporter.layerFlusher));
};

/**
 * Exports metrics to `url` and provides the shared flusher.
 */
const metricsLayer = (url: string, resource: TelemetryResource, settings: ExportSettings) =>
  OtlpMetrics.layer({ url, resource, ...settings });

/**
 * Exports log records to `url` through an OTLP logger added to the log export sinks. Records arrive
 * already redacted by the logger layer's fan-out logger. The sink stops taking records before its
 * exporter flushes on shutdown.
 */
const logsLayer = (url: string, resource: TelemetryResource, settings: ExportSettings) =>
  logExportSinkLayer(OtlpLogger.make({ url, resource, ...settings })).pipe(
    Layer.provideMerge(OtlpExporter.layerFlusher),
  );

/**
 * Picks the OTLP body encoding. Protobuf unless `json` is asked for.
 */
const serializationLayer = (
  serialization: TelemetryOptions['serialization'],
): Layer.Layer<OtlpSerialization.OtlpSerialization> => {
  if (serialization === 'json') {
    return OtlpSerialization.layerJson;
  }

  return OtlpSerialization.layerProtobuf;
};
