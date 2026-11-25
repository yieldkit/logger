import type { LogLevel } from 'effect';

import type { RedactionOptions } from './credentials.ts';

/**
 * Console encoding for one log line.
 */
export type LogFormat = 'json' | 'structured' | 'pretty' | 'logfmt';

/**
 * Requested format, including `auto`, which picks JSON in production and pretty otherwise.
 */
export type ConfiguredLogFormat = LogFormat | 'auto';

/**
 * Where console lines go. `true` sends every line to stderr, `false` sends every line to stdout,
 * and `leveled` sends Warn, Error and Fatal to stderr and everything else to stdout.
 */
export type LogStderrMode = boolean | 'leveled';

/**
 * Extra fields attached to one log line. `undefined` values are omitted before they are written.
 */
export type LogFields = Readonly<Record<string, unknown>>;

/**
 * Structured view of the first fail, die, or interrupt in a `Cause`.
 */
export interface ErrorSummary {
  /**
   * Which kind of reason was selected. A fail is preferred over a die, and a die over an interrupt.
   */
  readonly kind: 'fail' | 'die' | 'interrupt';

  /**
   * Human-readable message. An interrupt uses `Fiber interrupted`.
   */
  readonly message: string;

  /**
   * Effect `_tag` when the error is a tagged error.
   */
  readonly tag?: string;

  /**
   * `Error.name` or a `name` string property, when present.
   */
  readonly name?: string;

  /**
   * HTTP status copied from a numeric `status` property, when present.
   */
  readonly status?: number;

  /**
   * Fiber id of an interrupt, when Effect recorded one.
   */
  readonly fiberId?: number;
}

/**
 * One log line after formatting. JSON output is this record serialized.
 */
export interface StructuredLogRecord {
  /**
   * ISO-8601 time from Effect's logger clock.
   */
  readonly timestamp: string;

  /**
   * Severity label, such as `INFO` or `ERROR`.
   */
  readonly level: string;

  /**
   * Process name, such as `api`, when the layer was given one.
   */
  readonly service?: string;

  /**
   * Deployment environment, usually from `NODE_ENV`.
   */
  readonly env?: string;

  /**
   * Build version passed to the layer, when set.
   */
  readonly version?: string;

  /**
   * Log message. Effect may pass a non-string value.
   */
  readonly message: unknown;

  /**
   * Effect fiber that emitted the line.
   */
  readonly fiberId: string;

  /**
   * Active span trace id, when a parent span is in the fiber context.
   */
  readonly traceId?: string;

  /**
   * Active span id, when a parent span is in the fiber context.
   */
  readonly spanId?: string;

  /**
   * Fields from `Effect.annotateLogs` and the level helpers.
   */
  readonly annotations: LogFields;

  /**
   * Open log-span labels and their elapsed milliseconds.
   */
  readonly spans: Readonly<Record<string, number>>;

  /**
   * Pretty-printed cause, when the line has one.
   */
  readonly cause?: string;

  /**
   * First fail, die, or interrupt, when the cause is non-empty.
   */
  readonly error?: ErrorSummary;

  /**
   * True when the JSON line was shortened to fit the byte cap. A minimal record keeps only the
   * `kind`, `tag`, `name` and `status` of `error`, without its `message`.
   */
  readonly truncated?: boolean;
}

/**
 * Identity fields copied onto every structured line from one logger.
 */
export interface StructuredLoggerOptions {
  /**
   * Process name written as `service`.
   */
  readonly service?: string | undefined;

  /**
   * Environment written as `env`.
   */
  readonly env?: string | undefined;

  /**
   * Build version written as `version`.
   */
  readonly version?: string | undefined;

  /**
   * Largest JSON line, newline included, in UTF-8 bytes. Used only by the JSON logger, which
   * shortens the `cause`, then `error.message`, then the `message`, then falls back to a minimal
   * record, dropping its identity and trace fields under a very small cap. A cap smaller than a
   * record of only `timestamp`, `level` and `truncated` (about 80 bytes) cannot be met, and that
   * record is written anyway. Defaults to `DEFAULT_MAX_LINE_BYTES`.
   */
  readonly maxLineBytes?: number | undefined;

  /**
   * Extra sensitive and allowed key names and an optional text scrubber, for every redaction this
   * logger does. Omit to use the built-in sensitive names only.
   */
  readonly redaction?: RedactionOptions | undefined;
}

/**
 * Options for building a console logger layer. Omitted fields use the package defaults.
 */
export interface LoggerLayerOptions extends StructuredLoggerOptions {
  /**
   * Output encoding. `auto` is JSON in production and pretty otherwise.
   */
  readonly format?: ConfiguredLogFormat | undefined;

  /**
   * Lines below this severity are dropped. Defaults to `Info`.
   */
  readonly minLevel?: LogLevel.LogLevel | undefined;

  /**
   * Routes lines to stderr or stdout. `true` is stderr for every line, `false` is stdout for every
   * line, and `leveled` (the default) sends Warn, Error and Fatal to stderr.
   */
  readonly stderr?: LogStderrMode | undefined;

  /**
   * ANSI color mode for the pretty format. `auto` follows the terminal.
   */
  readonly colors?: 'auto' | boolean | undefined;

  /**
   * When true, also installs the redacted `Logger.tracerLogger` so lines become span events.
   * Defaults to true.
   */
  readonly includeTracerLogger?: boolean | undefined;
}

/**
 * Logger settings after environment variables and caller defaults are combined.
 */
export interface ResolvedLoggerConfig {
  /**
   * Process name, or omitted when the caller did not set one.
   */
  readonly service: string | undefined;

  /**
   * Environment used for `auto` format and written on each line.
   */
  readonly env: string;

  /**
   * Build version, or omitted when the caller did not set one.
   */
  readonly version: string | undefined;

  /**
   * Concrete format. `auto` has already been resolved.
   */
  readonly format: LogFormat;

  /**
   * Minimum severity that will be emitted.
   */
  readonly minLevel: LogLevel.LogLevel;

  /**
   * Stream routing: every line to stderr, every line to stdout, or `leveled`.
   */
  readonly stderr: LogStderrMode;

  /**
   * Color mode passed to the pretty formatter.
   */
  readonly colors: 'auto' | boolean;

  /**
   * Whether span events are recorded in addition to the console line.
   */
  readonly includeTracerLogger: boolean;

  /**
   * JSON line byte cap from the caller defaults. Omitted when the caller did not set one.
   */
  readonly maxLineBytes?: number | undefined;

  /**
   * Redaction options from the caller defaults. Omitted when the caller did not set any.
   */
  readonly redaction?: RedactionOptions | undefined;
}
