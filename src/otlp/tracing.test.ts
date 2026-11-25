import { ConfigProvider, Effect, Exit, Layer } from 'effect';
import { HttpClient, HttpClientResponse } from 'effect/http';
import { describe, expect, it } from 'vite-plus/test';

import { tracingLayer } from './tracing.ts';

/**
 * Metrics and logs requests, which `tracingLayer` also sends when a collector is configured.
 */
const OTHER_SIGNAL_PATH = /\/v1\/(metrics|logs)$/;

const exportSpan = async (env: Record<string, string>) => {
  const requests: Array<{ url: string; payload: string; contentType: string | undefined }> = [];
  const collector = HttpClient.make((request, url) => {
    const body = request.body;
    requests.push({
      url: url.href,
      payload: body._tag === 'Uint8Array' ? new TextDecoder().decode(body.body) : '',
      contentType: request.headers['content-type'],
    });
    return Effect.succeed(HttpClientResponse.fromWeb(request, new Response(null)));
  });
  const traces = tracingLayer('example-test').pipe(
    Layer.provide(Layer.succeed(HttpClient.HttpClient, collector)),
  );
  const exit = await Effect.runPromiseExit(
    Effect.void.pipe(
      Effect.withSpan('ingestion-test'),
      Effect.provide(traces),
      Effect.provideService(ConfigProvider.ConfigProvider, ConfigProvider.fromEnv({ env })),
    ),
  );
  return { exit, requests };
};

describe('tracingLayer', () => {
  it('keeps export disabled for an absent or blank endpoint and when disabled explicitly', async () => {
    const cases: ReadonlyArray<Record<string, string>> = [
      {},
      { OTEL_EXPORTER_OTLP_ENDPOINT: '' },
      { OTEL_EXPORTER_OTLP_ENDPOINT: '  ' },
      {
        OTEL_SDK_DISABLED: 'true',
        OTEL_EXPORTER_OTLP_ENDPOINT: 'http://collector.test',
      },
    ];
    const results = await Promise.all(cases.map(exportSpan));
    for (const { exit, requests } of results) {
      expect(Exit.isSuccess(exit)).toBe(true);
      expect(requests).toHaveLength(0);
    }
  });

  it('rejects an invalid endpoint at startup', async () => {
    const { exit, requests } = await exportSpan({ OTEL_EXPORTER_OTLP_ENDPOINT: 'invalid-url' });
    expect(Exit.isFailure(exit)).toBe(true);
    expect(requests).toHaveLength(0);
  });

  it('flushes protobuf spans on close and honors a full signal-specific endpoint', async () => {
    const base = { OTEL_EXPORTER_OTLP_ENDPOINT: 'https://collector.test/base/' };
    const cases: ReadonlyArray<readonly [Record<string, string>, string]> = [
      [base, 'https://collector.test/base/v1/traces'],
      [
        { ...base, OTEL_EXPORTER_OTLP_TRACES_ENDPOINT: 'https://collector.test/custom' },
        'https://collector.test/custom',
      ],
    ];
    const results = await Promise.all(
      cases.map(async ([env, expectedUrl]) => ({ expectedUrl, result: await exportSpan(env) })),
    );
    for (const { expectedUrl, result } of results) {
      const { exit } = result;
      const requests = result.requests.filter((request) => !OTHER_SIGNAL_PATH.test(request.url));
      expect(Exit.isSuccess(exit)).toBe(true);
      expect(requests).toHaveLength(1);
      expect(requests[0]).toMatchObject({
        url: expectedUrl,
        contentType: 'application/x-protobuf',
      });
      expect(requests[0]?.payload).toContain('example-test');
      expect(requests[0]?.payload).toContain('ingestion-test');
    }
  });
});
