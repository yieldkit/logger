import { ConfigProvider, Effect, Exit } from 'effect';
import { describe, expect, it } from 'vite-plus/test';

import type { LogStderrMode } from './types.ts';

import {
  parseLogFormat,
  parseLogLevel,
  parseLogStderr,
  readLoggerConfig,
  resolveLogFormat,
} from './config.ts';

/**
 * Reads the config from `env` and returns the resolved `stderr`, or `failed` on a ConfigError.
 */
const stderrOf = async (env: Record<string, string>): Promise<LogStderrMode | 'failed'> => {
  const exit = await Effect.runPromiseExit(
    readLoggerConfig().pipe(
      Effect.provideService(ConfigProvider.ConfigProvider, ConfigProvider.fromEnv({ env })),
    ),
  );
  return Exit.isSuccess(exit) ? exit.value.stderr : 'failed';
};

describe('parseLogLevel', () => {
  it('parses levels case-insensitively and rejects an unknown spelling', () => {
    expect(parseLogLevel('debug')).toBe('Debug');
    expect(parseLogLevel('WARNING')).toBe('Warn');
    expect(parseLogLevel('silent')).toBe('None');
    expect(parseLogLevel('unknown')).toBeUndefined();
  });
});

describe('parseLogFormat', () => {
  it('parses formats case-insensitively and rejects an unknown spelling', () => {
    expect(parseLogFormat('JSON')).toBe('json');
    expect(parseLogFormat('pretty')).toBe('pretty');
    expect(parseLogFormat('bogus')).toBeUndefined();
  });
});

describe('parseLogStderr', () => {
  it('parses leveled and the boolean spellings case-insensitively', () => {
    expect(parseLogStderr('leveled')).toBe('leveled');
    expect(parseLogStderr('LEVELED')).toBe('leveled');
    expect(parseLogStderr('true')).toBe(true);
    expect(parseLogStderr('0')).toBe(false);
    expect(parseLogStderr('bogus')).toBeUndefined();
  });
});

describe('inherited object keys', () => {
  it.each(['constructor', '__proto__', 'toString', 'hasOwnProperty'])(
    'treats %j as an unknown spelling',
    (raw) => {
      expect(parseLogLevel(raw)).toBeUndefined();
      expect(parseLogFormat(raw)).toBeUndefined();
      expect(parseLogStderr(raw)).toBeUndefined();
    },
  );

  it('fails readLoggerConfig on LOG_FORMAT=constructor', async () => {
    const exit = await Effect.runPromiseExit(
      readLoggerConfig().pipe(
        Effect.provideService(
          ConfigProvider.ConfigProvider,
          ConfigProvider.fromEnv({ env: { LOG_FORMAT: 'constructor' } }),
        ),
      ),
    );
    expect(Exit.isFailure(exit)).toBe(true);
  });
});

describe('resolveLogFormat', () => {
  it('uses JSON in production and pretty otherwise, leaving an explicit format unchanged', () => {
    expect(resolveLogFormat('auto', 'production')).toBe('json');
    expect(resolveLogFormat('auto', 'prod')).toBe('json');
    expect(resolveLogFormat('auto', 'development')).toBe('pretty');
    expect(resolveLogFormat('logfmt', 'production')).toBe('logfmt');
  });
});

describe('readLoggerConfig', () => {
  it('reads logger settings from Effect ConfigProvider and rejects an invalid level', async () => {
    const provider = ConfigProvider.fromEnv({
      env: {
        LOG_LEVEL: 'debug',
        LOG_FORMAT: 'json',
        LOG_STDERR: 'true',
        NODE_ENV: 'production',
      },
    });
    const resolved = await Effect.runPromise(
      readLoggerConfig({ service: 'worker', version: '1.0.0' }).pipe(
        Effect.provideService(ConfigProvider.ConfigProvider, provider),
      ),
    );
    expect(resolved).toEqual({
      service: 'worker',
      env: 'production',
      version: '1.0.0',
      format: 'json',
      minLevel: 'Debug',
      stderr: true,
      colors: 'auto',
      includeTracerLogger: true,
    });

    const invalidExit = await Effect.runPromiseExit(
      readLoggerConfig().pipe(
        Effect.provideService(
          ConfigProvider.ConfigProvider,
          ConfigProvider.fromEnv({ env: { LOG_LEVEL: 'loud' } }),
        ),
      ),
    );
    expect(Exit.isFailure(invalidExit)).toBe(true);
  });

  it('reads LOG_STDERR as leveled, true or false and rejects an invalid value', async () => {
    expect(await stderrOf({})).toBe('leveled');
    expect(await stderrOf({ LOG_STDERR: 'leveled' })).toBe('leveled');
    expect(await stderrOf({ LOG_STDERR: 'LEVELED' })).toBe('leveled');
    expect(await stderrOf({ LOG_STDERR: 'true' })).toBe(true);
    expect(await stderrOf({ LOG_STDERR: '0' })).toBe(false);
    expect(await stderrOf({ LOG_STDERR: 'sometimes' })).toBe('failed');
  });
});

/**
 * Reads the config from `env` and returns the resolved `colors`, or the ConfigError text.
 */
const colorsOf = async (env: Record<string, string>): Promise<boolean | string> => {
  const exit = await Effect.runPromiseExit(
    readLoggerConfig().pipe(
      Effect.provideService(ConfigProvider.ConfigProvider, ConfigProvider.fromEnv({ env })),
    ),
  );
  return Exit.isSuccess(exit) ? exit.value.colors : String(exit.cause);
};

describe('LOG_COLORS', () => {
  it('accepts the same boolean spellings as LOG_STDERR and lists them when rejecting', async () => {
    expect(await colorsOf({ LOG_COLORS: 'y' })).toBe(true);
    expect(await colorsOf({ LOG_COLORS: 'N' })).toBe(false);
    expect(await colorsOf({ LOG_COLORS: 'sometimes' })).toContain(
      'auto, true, yes, on, 1, y, false, no, off, 0, n',
    );
  });
});
