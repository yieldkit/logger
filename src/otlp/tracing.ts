import type { Config, Layer } from 'effect';
import type { HttpClient } from 'effect/http';
import type { OtlpExporter } from 'effect/observability';

import type { TelemetryOptions } from './telemetry.ts';

import { telemetryLayer } from './telemetry.ts';

/**
 * `telemetryLayer` with `serviceName` as the only required option. It exports traces, metrics and
 * logs whenever a collector is configured, provides the shared `OtlpExporter.Flusher`, and fails
 * with `ConfigError` on an invalid endpoint or exporter value. See `telemetryLayer` for the
 * variables it reads.
 */
export const tracingLayer = (
  serviceName: string,
  options: Omit<TelemetryOptions, 'serviceName'> = {},
): Layer.Layer<OtlpExporter.Flusher, Config.ConfigError, HttpClient.HttpClient> =>
  telemetryLayer({ ...options, serviceName });
