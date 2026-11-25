import type { LogLevel } from 'effect';

import { Config, Option, Schema } from 'effect';

import type {
  ConfiguredLogFormat,
  LogFormat,
  LoggerLayerOptions,
  LogStderrMode,
  ResolvedLoggerConfig,
} from './types.ts';

/**
 * Accepted spellings of one environment variable, keyed by the trimmed, lowercased input and mapped
 * to the value each one selects.
 */
interface AliasTable<Value> {
  readonly [spelling: string]: Value;
}

/**
 * Accepted `LOG_LEVEL` spellings, including `warning` and `silent`.
 */
const LOG_LEVEL_ALIASES: AliasTable<LogLevel.LogLevel> = {
  /**
   * Enables every severity.
   */
  all: 'All',

  /**
   * Enables trace and above.
   */
  trace: 'Trace',

  /**
   * Enables debug and above.
   */
  debug: 'Debug',

  /**
   * Enables info and above. This is the default.
   */
  info: 'Info',

  /**
   * Enables warnings and above.
   */
  warn: 'Warn',

  /**
   * Alias of `warn`.
   */
  warning: 'Warn',

  /**
   * Enables errors and fatal lines only.
   */
  error: 'Error',

  /**
   * Enables fatal lines only.
   */
  fatal: 'Fatal',

  /**
   * Drops every line.
   */
  none: 'None',

  /**
   * Alias of `none`.
   */
  silent: 'None',
};

/**
 * Accepted `LOG_FORMAT` spellings.
 */
const LOG_FORMAT_ALIASES: AliasTable<ConfiguredLogFormat> = {
  /**
   * JSON in production, pretty otherwise.
   */
  auto: 'auto',

  /**
   * One JSON object per line.
   */
  json: 'json',

  /**
   * One structured object per line, not serialized.
   */
  structured: 'structured',

  /**
   * Effect's colored console format.
   */
  pretty: 'pretty',

  /**
   * One logfmt line.
   */
  logfmt: 'logfmt',
};

/**
 * Accepted `LOG_COLORS` spellings.
 */
const LOG_COLOR_ALIASES: AliasTable<'auto' | boolean> = {
  /**
   * Follows the terminal.
   */
  auto: 'auto',

  /**
   * Forces ANSI color.
   */
  true: true,

  /**
   * Alias of `true`.
   */
  '1': true,

  /**
   * Alias of `true`.
   */
  yes: true,

  /**
   * Alias of `true`.
   */
  on: true,

  /**
   * Alias of `true`.
   */
  y: true,

  /**
   * Disables ANSI color.
   */
  false: false,

  /**
   * Alias of `false`.
   */
  '0': false,

  /**
   * Alias of `false`.
   */
  no: false,

  /**
   * Alias of `false`.
   */
  off: false,

  /**
   * Alias of `false`.
   */
  n: false,
};

/**
 * Accepted `LOG_STDERR` spellings: the boolean spellings Effect's `Config.Boolean` accepts, plus
 * `leveled`.
 */
const LOG_STDERR_ALIASES: AliasTable<LogStderrMode> = {
  /**
   * Warn, Error and Fatal go to stderr, everything else to stdout. This is the default.
   */
  leveled: 'leveled',

  /**
   * Every line goes to stderr.
   */
  true: true,

  /**
   * Alias of `true`.
   */
  yes: true,

  /**
   * Alias of `true`.
   */
  on: true,

  /**
   * Alias of `true`.
   */
  '1': true,

  /**
   * Alias of `true`.
   */
  y: true,

  /**
   * Every line goes to stdout.
   */
  false: false,

  /**
   * Alias of `false`.
   */
  no: false,

  /**
   * Alias of `false`.
   */
  off: false,

  /**
   * Alias of `false`.
   */
  '0': false,

  /**
   * Alias of `false`.
   */
  n: false,
};

/**
 * Looks up the trimmed, lowercased `raw` among the table's own spellings, so an inherited name such
 * as `constructor` or `__proto__` is unknown rather than a value from `Object.prototype`.
 */
const lookupAlias = <Value>(table: AliasTable<Value>, raw: string): Value | undefined => {
  const spelling = raw.trim().toLowerCase();
  return Object.hasOwn(table, spelling) ? table[spelling] : undefined;
};

/**
 * Parses a case-insensitive `LOG_LEVEL` value. An unknown spelling returns `undefined`.
 */
export const parseLogLevel = (raw: string): LogLevel.LogLevel | undefined =>
  lookupAlias(LOG_LEVEL_ALIASES, raw);

/**
 * Parses a case-insensitive `LOG_FORMAT` value. An unknown spelling returns `undefined`.
 */
export const parseLogFormat = (raw: string): ConfiguredLogFormat | undefined =>
  lookupAlias(LOG_FORMAT_ALIASES, raw);

/**
 * Parses a case-insensitive `LOG_STDERR` value: a boolean spelling or `leveled`. An unknown
 * spelling returns `undefined`.
 */
export const parseLogStderr = (raw: string): LogStderrMode | undefined =>
  lookupAlias(LOG_STDERR_ALIASES, raw);

/**
 * Parses a case-insensitive `LOG_COLORS` value. An unknown spelling returns `undefined`.
 */
export const parseLogColors = (raw: string): 'auto' | boolean | undefined =>
  lookupAlias(LOG_COLOR_ALIASES, raw);

/**
 * Resolves `auto` to `json` when `env` is `production` or `prod`, otherwise to `pretty`. Any other
 * format is returned unchanged.
 */
export const resolveLogFormat = (format: ConfiguredLogFormat, env?: string): LogFormat => {
  if (format !== 'auto') {
    return format;
  }

  const normalizedEnv = env?.trim().toLowerCase();
  return normalizedEnv === 'production' || normalizedEnv === 'prod' ? 'json' : 'pretty';
};

/**
 * `LOG_LEVEL` text that `parseLogLevel` accepts.
 */
const LogLevelInputSchema = Schema.String.check(
  Schema.makeFilter((raw) => parseLogLevel(raw) !== undefined, {
    message:
      'Expected LOG_LEVEL to be one of all, trace, debug, info, warn, warning, error, fatal, none, silent',
  }),
);

/**
 * `LOG_FORMAT` text that `parseLogFormat` accepts.
 */
const LogFormatInputSchema = Schema.String.check(
  Schema.makeFilter((raw) => parseLogFormat(raw) !== undefined, {
    message: 'Expected LOG_FORMAT to be one of auto, json, structured, pretty, logfmt',
  }),
);

/**
 * `LOG_COLORS` text that `parseLogColors` accepts.
 */
const LogColorsInputSchema = Schema.String.check(
  Schema.makeFilter((raw) => parseLogColors(raw) !== undefined, {
    message: 'Expected LOG_COLORS to be one of auto, true, yes, on, 1, y, false, no, off, 0, n',
  }),
);

/**
 * `LOG_STDERR` text that `parseLogStderr` accepts.
 */
const LogStderrInputSchema = Schema.String.check(
  Schema.makeFilter((raw) => parseLogStderr(raw) !== undefined, {
    message: 'Expected LOG_STDERR to be one of true, yes, on, 1, y, false, no, off, 0, n, leveled',
  }),
);

/**
 * Optional `LOG_LEVEL` config. A missing variable is left for the caller default.
 */
const LogLevelConfig = Config.schema(LogLevelInputSchema, 'LOG_LEVEL').pipe(
  Config.map((raw): LogLevel.LogLevel => parseLogLevel(raw) ?? 'Info'),
);

/**
 * Optional `LOG_FORMAT` config. A missing variable is left for the caller default.
 */
const LogFormatConfig = Config.schema(LogFormatInputSchema, 'LOG_FORMAT').pipe(
  Config.map((raw): ConfiguredLogFormat => parseLogFormat(raw) ?? 'auto'),
);

/**
 * Optional `LOG_COLORS` config. A missing variable is left for the caller default.
 */
const LogColorsConfig = Config.schema(LogColorsInputSchema, 'LOG_COLORS').pipe(
  Config.map((raw): 'auto' | boolean => parseLogColors(raw) ?? 'auto'),
);

/**
 * Optional `LOG_STDERR` config. A missing variable is left for the caller default.
 */
const LogStderrConfig = Config.schema(LogStderrInputSchema, 'LOG_STDERR').pipe(
  Config.map((raw): LogStderrMode => parseLogStderr(raw) ?? 'leveled'),
);

/**
 * Reads logger settings from the environment and fills gaps from `defaults`. An invalid
 * `LOG_LEVEL`, `LOG_FORMAT`, `LOG_STDERR`, or `LOG_COLORS` fails with `ConfigError`.
 */
export const readLoggerConfig = (
  defaults: LoggerLayerOptions = {},
): Config.Config<ResolvedLoggerConfig> =>
  Config.all({
    minLevel: Config.option(LogLevelConfig),
    format: Config.option(LogFormatConfig),
    stderr: Config.option(LogStderrConfig),
    colors: Config.option(LogColorsConfig),
    nodeEnv: Config.option(Config.NonEmptyString('NODE_ENV')),
  }).pipe(
    Config.map(({ minLevel, format, stderr, colors, nodeEnv }): ResolvedLoggerConfig => {
      const env = Option.getOrElse(nodeEnv, () => defaults.env ?? 'development');
      const configuredFormat = Option.getOrElse(format, () => defaults.format ?? 'auto');
      return {
        service: defaults.service,
        env,
        version: defaults.version,
        format: resolveLogFormat(configuredFormat, env),
        minLevel: Option.getOrElse(minLevel, () => defaults.minLevel ?? 'Info'),
        stderr: Option.getOrElse(stderr, () => defaults.stderr ?? 'leveled'),
        colors: Option.getOrElse(colors, () => defaults.colors ?? 'auto'),
        includeTracerLogger: defaults.includeTracerLogger ?? true,
        maxLineBytes: defaults.maxLineBytes,
        redaction: defaults.redaction,
      };
    }),
  );
