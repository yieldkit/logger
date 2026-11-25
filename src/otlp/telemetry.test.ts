import { Config, ConfigProvider, Data, Effect, Exit, Layer, Metric, Schema } from 'effect';
import { HttpClient, HttpClientResponse } from 'effect/http';
import { OtlpExporter } from 'effect/observability';
import { TestConsole } from 'effect/testing';
import { describe, expect, it } from 'vite-plus/test';

import type { TelemetryOptions } from './telemetry.ts';

import { logDebug, logFailure, logInfo } from '../context.ts';
import { makeLoggerLayer } from '../layer.ts';
import { telemetryLayer } from './telemetry.ts';

/**
 * Failure of the traced call, whose message carries a bearer token and URL userinfo.
 */
class UpstreamCallError extends Data.TaggedError('UpstreamCallError')<{
  readonly message: string;
}> {}

/**
 * One POST seen by the fake collector.
 */
type CollectorRequest = {
  readonly url: string;
  readonly payload: string;
  readonly headers: Readonly<Record<string, string>>;
};

/**
 * Base collector URL used by most cases.
 */
const COLLECTOR = 'https://collector.test';

/**
 * Counter bumped by every case so the metrics exporter has a data point to send.
 */
const testCounter = Metric.counter('example_telemetry_test_total');

/**
 * Builds a fake `HttpClient` that records every request URL and decoded body.
 */
const makeCollector = () => {
  const requests: Array<CollectorRequest> = [];
  const client = HttpClient.make((request, url) => {
    const body = request.body;
    requests.push({
      url: url.href,
      payload: body._tag === 'Uint8Array' ? new TextDecoder().decode(body.body) : '',
      headers: { ...request.headers },
    });
    return Effect.succeed(HttpClientResponse.fromWeb(request, new Response(null)));
  });
  return { requests, layer: Layer.succeed(HttpClient.HttpClient, client) };
};

/**
 * Builds `telemetryLayer` with JSON bodies and the given overrides, wired to `collector`.
 */
const makeTelemetry = (
  collector: ReturnType<typeof makeCollector>,
  options: Partial<TelemetryOptions> = {},
) =>
  telemetryLayer({ serviceName: 'example-test', serialization: 'json', ...options }).pipe(
    Layer.provide(collector.layer),
  );

/**
 * Emits one span, one metric update and one log line with secrets in the message and fields.
 */
const emitSignals = Effect.gen(function* () {
  yield* Metric.update(testCounter, 1);
  yield* logInfo('Bearer abc123', { password: 'hunter2' });
}).pipe(Effect.withSpan('telemetry-span'));

/**
 * Runs `program` under the console logger and `telemetryLayer`, merged, with `env` as the only
 * configuration source. Returns the exit and every request sent before and after the scope closed.
 */
const runTelemetry = async <A>(
  env: Record<string, string>,
  program: Effect.Effect<A, never, OtlpExporter.Flusher>,
  options: Partial<TelemetryOptions> = {},
) => {
  const collector = makeCollector();
  const layer = Layer.mergeAll(
    makeLoggerLayer({ format: 'json' }),
    makeTelemetry(collector, options),
  );
  const exit = await Effect.runPromiseExit(
    program.pipe(
      Effect.provide(layer.pipe(Layer.provideMerge(TestConsole.layer))),
      Effect.provideService(ConfigProvider.ConfigProvider, ConfigProvider.fromEnv({ env })),
    ),
  );
  return { exit, requests: collector.requests };
};

/**
 * Path of every request, sorted, for order-independent assertions.
 */
const pathsOf = (requests: ReadonlyArray<CollectorRequest>): Array<string> =>
  requests.map((request) => new URL(request.url).pathname).toSorted();

/**
 * One OTLP/JSON resource attribute. Only string values are read.
 */
const OtlpAttribute = Schema.Struct({
  key: Schema.String,
  value: Schema.Struct({ stringValue: Schema.optional(Schema.String) }),
});

/**
 * OTLP/JSON body of any signal: one `resource<Signal>` array whose entries carry a resource.
 */
const OtlpPayload = Schema.fromJsonString(
  Schema.Record(
    Schema.String,
    Schema.Array(
      Schema.Struct({ resource: Schema.Struct({ attributes: Schema.Array(OtlpAttribute) }) }),
    ),
  ),
);

/**
 * Reads the string resource attributes of the first resource in an OTLP/JSON payload.
 */
const resourceAttributes = (payload: string) => {
  const [resources = []] = Object.values(Schema.decodeSync(OtlpPayload)(payload));
  const attributes = resources[0]?.resource.attributes ?? [];
  return Object.fromEntries(
    attributes.map((attribute) => [attribute.key, attribute.value.stringValue]),
  );
};

/**
 * Returns the single request sent to `path`, failing the test when there is not exactly one.
 */
const requestTo = (requests: ReadonlyArray<CollectorRequest>, path: string): CollectorRequest => {
  const matches = requests.filter((request) => new URL(request.url).pathname === path);
  expect(matches).toHaveLength(1);
  return matches[0] ?? { url: '', payload: '', headers: {} };
};

describe('telemetryLayer', () => {
  it('exports traces, metrics and logs to the base endpoint when the scope closes', async () => {
    const { exit, requests } = await runTelemetry(
      { OTEL_EXPORTER_OTLP_ENDPOINT: `${COLLECTOR}/base` },
      emitSignals,
    );
    expect(Exit.isSuccess(exit)).toBe(true);
    expect(pathsOf(requests)).toEqual(['/base/v1/logs', '/base/v1/metrics', '/base/v1/traces']);
    expect(requestTo(requests, '/base/v1/traces').payload).toContain('telemetry-span');
    expect(requestTo(requests, '/base/v1/metrics').payload).toContain(
      'example_telemetry_test_total',
    );
  });

  it('drains every signal through one shared Flusher before the scope closes', async () => {
    const collector = makeCollector();
    const env = { OTEL_EXPORTER_OTLP_ENDPOINT: COLLECTOR };
    const flushed = await Effect.runPromise(
      Effect.gen(function* () {
        yield* emitSignals;
        const flusher = yield* OtlpExporter.Flusher;
        yield* flusher.flush;
        return pathsOf(collector.requests);
      }).pipe(
        Effect.provide(
          Layer.mergeAll(makeLoggerLayer({ format: 'json' }), makeTelemetry(collector)).pipe(
            Layer.provideMerge(TestConsole.layer),
          ),
        ),
        Effect.provideService(ConfigProvider.ConfigProvider, ConfigProvider.fromEnv({ env })),
      ),
    );
    expect(flushed).toEqual(['/v1/logs', '/v1/metrics', '/v1/traces']);
  });

  it('skips a signal set to none, in any case', async () => {
    const { requests } = await runTelemetry(
      { OTEL_EXPORTER_OTLP_ENDPOINT: COLLECTOR, OTEL_LOGS_EXPORTER: ' NONE ' },
      emitSignals,
    );
    expect(pathsOf(requests)).toEqual(['/v1/metrics', '/v1/traces']);
  });

  it('skips a signal turned off in code', async () => {
    const { requests } = await runTelemetry(
      { OTEL_EXPORTER_OTLP_ENDPOINT: COLLECTOR },
      emitSignals,
      {
        signals: { traces: false },
      },
    );
    expect(pathsOf(requests)).toEqual(['/v1/logs', '/v1/metrics']);
  });

  it('exports only the signal whose own endpoint is set', async () => {
    const { requests } = await runTelemetry(
      { OTEL_EXPORTER_OTLP_METRICS_ENDPOINT: `${COLLECTOR}/custom-metrics` },
      emitSignals,
    );
    expect(requests.map((request) => request.url)).toEqual([`${COLLECTOR}/custom-metrics`]);
  });

  it('rejects an invalid endpoint, compression or timeout with a ConfigError', async () => {
    const cases: ReadonlyArray<Record<string, string>> = [
      { OTEL_EXPORTER_OTLP_LOGS_ENDPOINT: 'invalid-url' },
      { OTEL_EXPORTER_OTLP_ENDPOINT: 'ftp://collector.test' },
      { OTEL_EXPORTER_OTLP_ENDPOINT: COLLECTOR, OTEL_EXPORTER_OTLP_COMPRESSION: 'zip' },
      { OTEL_EXPORTER_OTLP_ENDPOINT: COLLECTOR, OTEL_EXPORTER_OTLP_TIMEOUT: 'soon' },
    ];
    const results = await Promise.all(cases.map((env) => runTelemetry(env, Effect.void)));
    for (const { exit, requests } of results) {
      const failure = Exit.isFailure(exit) ? String(exit.cause) : '';
      expect(failure).toContain(Config.ConfigError.name);
      expect(requests).toHaveLength(0);
    }
  });

  it('sends OTEL_EXPORTER_OTLP_HEADERS and the signal-specific headers with each export', async () => {
    const { requests } = await runTelemetry(
      {
        OTEL_EXPORTER_OTLP_ENDPOINT: COLLECTOR,
        OTEL_EXPORTER_OTLP_HEADERS: 'x-api-key=base%20key',
        OTEL_EXPORTER_OTLP_TRACES_HEADERS: 'x-api-key=traces-key',
      },
      emitSignals,
    );
    const keyOf = (path: string) =>
      requests.find((request) => new URL(request.url).pathname === path)?.headers['x-api-key'];
    expect(keyOf('/v1/traces')).toBe('traces-key');
    expect(keyOf('/v1/metrics')).toBe('base key');
    expect(keyOf('/v1/logs')).toBe('base key');
  });

  it('trims the whitespace the OTLP header list format allows around each entry', async () => {
    const { exit, requests } = await runTelemetry(
      { OTEL_EXPORTER_OTLP_ENDPOINT: COLLECTOR, OTEL_EXPORTER_OTLP_HEADERS: 'x-a=1, x-b = 2 ' },
      emitSignals,
    );
    expect(exit._tag).toBe('Success');
    const headers = requestTo(requests, '/v1/traces').headers;
    expect(headers['x-a']).toBe('1');
    expect(headers['x-b']).toBe('2');
  });

  it('lets the headers option replace the header variables', async () => {
    const { requests } = await runTelemetry(
      { OTEL_EXPORTER_OTLP_ENDPOINT: COLLECTOR, OTEL_EXPORTER_OTLP_HEADERS: 'x-api-key=env' },
      emitSignals,
      { headers: { 'x-api-key': 'code' } },
    );
    expect(requests.length).toBeGreaterThan(0);
    expect(requests.map((request) => request.headers['x-api-key'])).toEqual(
      requests.map(() => 'code'),
    );
  });

  it('compresses export bodies when OTEL_EXPORTER_OTLP_COMPRESSION is gzip', async () => {
    const { requests } = await runTelemetry(
      {
        OTEL_EXPORTER_OTLP_LOGS_ENDPOINT: `${COLLECTOR}/v1/logs`,
        OTEL_EXPORTER_OTLP_COMPRESSION: 'gzip',
      },
      logInfo('large line', { blob: 'x'.repeat(4096) }),
    );
    expect(requests.map((request) => request.headers['content-encoding'])).toEqual(['gzip']);
  });

  it('accepts exporter lists and any casing of OTEL_SDK_DISABLED', async () => {
    const listed = await runTelemetry(
      {
        OTEL_EXPORTER_OTLP_ENDPOINT: COLLECTOR,
        OTEL_TRACES_EXPORTER: 'console, OTLP',
        OTEL_METRICS_EXPORTER: 'prometheus',
        OTEL_LOGS_EXPORTER: 'none',
      },
      emitSignals,
    );
    expect(Exit.isSuccess(listed.exit)).toBe(true);
    expect(pathsOf(listed.requests)).toEqual(['/v1/traces']);

    const disabled = await runTelemetry(
      { OTEL_SDK_DISABLED: 'TRUE', OTEL_EXPORTER_OTLP_ENDPOINT: COLLECTOR },
      emitSignals,
    );
    expect(Exit.isSuccess(disabled.exit)).toBe(true);
    expect(disabled.requests).toHaveLength(0);

    const unknown = await runTelemetry(
      { OTEL_SDK_DISABLED: 'yes please', OTEL_EXPORTER_OTLP_ENDPOINT: COLLECTOR },
      emitSignals,
    );
    expect(Exit.isSuccess(unknown.exit)).toBe(true);
    expect(unknown.requests.length).toBeGreaterThan(0);
  });

  it('masks credentials in span names and span event names', async () => {
    const { requests } = await runTelemetry(
      { OTEL_EXPORTER_OTLP_TRACES_ENDPOINT: `${COLLECTOR}/v1/traces` },
      Effect.currentSpan.pipe(
        Effect.flatMap((span) =>
          Effect.sync(() => {
            span.event('retry with Bearer evt-secret', 0n);
          }),
        ),
        Effect.withSpan('GET https://user:span-secret@api.example/x'),
        Effect.orDie,
      ),
    );
    const payload = requests.map((request) => request.payload).join('');
    expect(payload).toContain('Bearer <redacted>');
    expect(payload).not.toContain('evt-secret');
    expect(payload).not.toContain('span-secret');
  });

  it('treats blank header, compression and timeout variables as unset', async () => {
    const { exit, requests } = await runTelemetry(
      {
        OTEL_EXPORTER_OTLP_ENDPOINT: COLLECTOR,
        OTEL_EXPORTER_OTLP_HEADERS: '',
        OTEL_EXPORTER_OTLP_COMPRESSION: ' ',
        OTEL_EXPORTER_OTLP_TIMEOUT: '',
      },
      emitSignals,
    );
    expect(Exit.isSuccess(exit)).toBe(true);
    expect(pathsOf(requests)).toEqual(['/v1/logs', '/v1/metrics', '/v1/traces']);
  });

  it('exports logs from an app the telemetry and logger layers are provided to', async () => {
    const collector = makeCollector();
    const app = Layer.effectDiscard(logInfo('from inside the app'));
    const composed = app.pipe(
      Layer.provide(makeTelemetry(collector)),
      Layer.provide(makeLoggerLayer({ format: 'json' })),
      Layer.provide(TestConsole.layer),
    );
    const exit = await Effect.runPromiseExit(
      Effect.scoped(Layer.build(composed)).pipe(
        Effect.provideService(
          ConfigProvider.ConfigProvider,
          ConfigProvider.fromEnv({
            env: { OTEL_EXPORTER_OTLP_LOGS_ENDPOINT: `${COLLECTOR}/v1/logs` },
          }),
        ),
      ),
    );
    expect(Exit.isSuccess(exit)).toBe(true);
    expect(requestTo(collector.requests, '/v1/logs').payload).toContain('from inside the app');
  });

  it('sends nothing when the SDK is disabled', async () => {
    const { exit, requests } = await runTelemetry(
      { OTEL_SDK_DISABLED: 'true', OTEL_EXPORTER_OTLP_ENDPOINT: COLLECTOR },
      Effect.gen(function* () {
        yield* emitSignals;
        const flusher = yield* OtlpExporter.Flusher;
        yield* flusher.flush;
      }),
    );
    expect(Exit.isSuccess(exit)).toBe(true);
    expect(requests).toHaveLength(0);
  });

  it('takes service.version from the option and the environment from NODE_ENV', async () => {
    const { requests } = await runTelemetry(
      { OTEL_EXPORTER_OTLP_TRACES_ENDPOINT: `${COLLECTOR}/v1/traces`, NODE_ENV: 'staging' },
      emitSignals,
      { serviceVersion: '1.2.3' },
    );
    expect(resourceAttributes(requestTo(requests, '/v1/traces').payload)).toMatchObject({
      'service.name': 'example-test',
      'service.version': '1.2.3',
      'deployment.environment.name': 'staging',
    });
  });

  it('lets OTEL_SERVICE_VERSION and OTEL_RESOURCE_ATTRIBUTES fill in and override', async () => {
    const { requests } = await runTelemetry(
      {
        OTEL_EXPORTER_OTLP_TRACES_ENDPOINT: `${COLLECTOR}/v1/traces`,
        NODE_ENV: 'production',
        OTEL_SERVICE_VERSION: '9.9.9',
        OTEL_RESOURCE_ATTRIBUTES: 'deployment.environment.name=eu-prod,team=example',
      },
      emitSignals,
      { environment: 'ignored' },
    );
    expect(resourceAttributes(requestTo(requests, '/v1/traces').payload)).toMatchObject({
      'service.version': '9.9.9',
      'deployment.environment.name': 'eu-prod',
      team: 'example',
    });
  });

  it('exports log records redacted', async () => {
    const { requests } = await runTelemetry(
      { OTEL_EXPORTER_OTLP_ENDPOINT: COLLECTOR },
      emitSignals,
    );
    const payload = requestTo(requests, '/v1/logs').payload;
    expect(payload).toContain('<redacted>');
    expect(payload).not.toContain('abc123');
    expect(payload).not.toContain('hunter2');
  });

  it('redacts the exported cause and drops records below the minimum level', async () => {
    const program = Effect.gen(function* () {
      yield* logDebug('debug-below-minimum');
      yield* logFailure('upstream failed', new Error('call failed: Bearer abc123'));
    });
    const { requests } = await runTelemetry({ OTEL_EXPORTER_OTLP_ENDPOINT: COLLECTOR }, program);
    const payload = requestTo(requests, '/v1/logs').payload;
    expect(payload).toContain('upstream failed');
    expect(payload).toContain('Bearer <redacted>');
    expect(payload).not.toContain('abc123');
    expect(payload).not.toContain('debug-below-minimum');
  });

  it('exports a failed span with its cause, attributes and link attributes redacted', async () => {
    const program = Effect.fail(
      new UpstreamCallError({ message: 'call failed: Bearer abc123 https://u:hunter2@h/' }),
    ).pipe(
      Effect.withSpan('failing-span', {
        attributes: { password: 'pw-attribute', target: 'https://u:userinfo-secret@h/' },
      }),
      Effect.ignore,
    );
    const linked = Effect.gen(function* () {
      const parent = yield* Effect.currentSpan;
      const addLink = Effect.map(Effect.currentSpan, (child) => {
        child.addLinks([{ span: parent, attributes: { password: 'add-links-secret' } }]);
      });
      yield* addLink.pipe(
        Effect.withSpan('linking-span', {
          links: [{ span: parent, attributes: { token: 'link-option-secret' } }],
        }),
        Effect.linkSpans(parent, { sessionId: 'link-spans-secret' }),
      );
    }).pipe(Effect.orDie);
    const withAnnotation = Effect.annotateCurrentSpan('apiKey', 'sk-annotated').pipe(
      Effect.andThen(program),
      Effect.andThen(linked),
      Effect.withSpan('annotated-span'),
    );
    const { requests } = await runTelemetry(
      { OTEL_EXPORTER_OTLP_ENDPOINT: COLLECTOR },
      withAnnotation,
    );
    const payload = requestTo(requests, '/v1/traces').payload;
    expect(payload).toContain('failing-span');
    expect(payload).toContain('exception');
    expect(payload).toContain('<redacted>');
    expect(payload).toContain('linking-span');
    const secrets = [
      'abc123',
      'hunter2',
      'sk-annotated',
      'pw-attribute',
      'userinfo-secret',
      'link-option-secret',
      'link-spans-secret',
      'add-links-secret',
    ];
    for (const secret of secrets) {
      expect(payload).not.toContain(secret);
    }
  });

  it('ignores an invalid base URL when every enabled signal has its own endpoint', async () => {
    const { exit } = await runTelemetry(
      {
        OTEL_EXPORTER_OTLP_ENDPOINT: 'invalid-url',
        OTEL_EXPORTER_OTLP_TRACES_ENDPOINT: `${COLLECTOR}/v1/traces`,
      },
      Effect.void,
      { signals: { metrics: false, logs: false } },
    );
    expect(Exit.isSuccess(exit)).toBe(true);
  });
});

describe('telemetryLayer with the console logger', () => {
  const env = { OTEL_EXPORTER_OTLP_ENDPOINT: COLLECTOR };

  /**
   * Runs `effect` with `TestConsole` and `env`, returning its value and the stdout lines.
   */
  const withConsole = <A, E>(effect: Effect.Effect<A, E>) =>
    Effect.runPromise(
      Effect.gen(function* () {
        yield* effect;
        return yield* TestConsole.logLines;
      }).pipe(
        Effect.provide(TestConsole.layer),
        Effect.provideService(ConfigProvider.ConfigProvider, ConfigProvider.fromEnv({ env })),
      ),
    );

  it('writes to the console and the collector when merged with the logger layer', async () => {
    const collector = makeCollector();
    const lines = await withConsole(
      logInfo('composition-merged').pipe(
        Effect.provide(
          Layer.mergeAll(makeLoggerLayer({ format: 'json' }), makeTelemetry(collector)),
        ),
      ),
    );
    expect(lines.join('\n')).toContain('composition-merged');
    expect(requestTo(collector.requests, '/v1/logs').payload).toContain('composition-merged');
  });

  it('writes to the console and the collector when both are provided to an app layer', async () => {
    const collector = makeCollector();
    const app = Layer.effectDiscard(logInfo('composition-provided'));
    const lines = await withConsole(
      Effect.void.pipe(
        Effect.provide(
          app.pipe(
            Layer.provide(makeTelemetry(collector)),
            Layer.provide(makeLoggerLayer({ format: 'json' })),
          ),
        ),
      ),
    );
    expect(lines.join('\n')).toContain('composition-provided');
    expect(requestTo(collector.requests, '/v1/logs').payload).toContain('composition-provided');
  });

  it('stops forwarding to the collector once the telemetry scope closes', async () => {
    const collector = makeCollector();
    const lines = await withConsole(
      Effect.gen(function* () {
        yield* Effect.void.pipe(Effect.provide(makeTelemetry(collector)));
        yield* logInfo('after-close');
      }).pipe(Effect.provide(makeLoggerLayer({ format: 'json' }))),
    );
    expect(lines.join('\n')).toContain('after-close');
    expect(collector.requests.map((request) => request.payload).join('')).not.toContain(
      'after-close',
    );
  });
});
