import type { LogLevel, Scope } from 'effect';

import { Cause, Effect, Predicate, Redactable } from 'effect';

import type { LogFields } from './types.ts';

import { extractErrorFields } from './error.ts';
import { ownEntries, withVisible } from './redact-walk.ts';

/**
 * Reads the own entries that become the fields: those of the redacted form of a `Redactable` record
 * (such as Effect's `Headers`, which hides the names in `Headers.CurrentRedactedNames`), otherwise
 * those of `fields` itself. Each property is read on its own, so a getter that throws gives
 * `[Unserializable]` for that property only. A redacted form that is not an object, or an object
 * whose keys cannot be listed, gives no entries.
 */
const visibleEntries = (fields: LogFields): ReadonlyArray<readonly [string, unknown]> => {
  try {
    return withVisible(fields, (visible) =>
      Predicate.isObject(visible) ? ownEntries(visible) : [],
    );
  } catch {
    return [];
  }
};

/**
 * Returns a copy of `fields` with `undefined` values removed. An empty input returns an empty
 * object and does not annotate the effect. Every key, `__proto__` included, is copied as an own
 * data property. A `Redactable` record (Effect's `Headers`) is copied from its redacted form,
 * resolved in the current fiber's context. A property whose getter throws becomes
 * `[Unserializable]`, and an object whose keys cannot be listed gives `{}`, so this never throws.
 */
export const compactLogFields = (fields: LogFields): LogFields =>
  Object.fromEntries(visibleEntries(fields).filter(([, value]) => value !== undefined));

/**
 * Annotates `effect` with the compacted `fields`.
 */
const annotateWith = <A, E, R>(
  effect: Effect.Effect<A, E, R>,
  fields: LogFields,
): Effect.Effect<A, E, R> => {
  const compacted = compactLogFields(fields);
  if (Object.keys(compacted).length === 0) {
    return effect;
  }

  return effect.pipe(Effect.annotateLogs(compacted));
};

/**
 * Checks whether fields need the running fiber's context without letting a proxy throw.
 */
const needsFiberContext = (fields: LogFields): boolean => {
  try {
    return Redactable.isRedactable(fields);
  } catch {
    return false;
  }
};

/**
 * Annotates `effect` with `fields`. A set of only `undefined` values is a no-op. A `Redactable`
 * record (Effect's `Headers`) is resolved when the effect runs, so the redacted names in the
 * running fiber's context apply. A record whose keys cannot be listed adds no annotations.
 */
export const withLogContext =
  (fields: LogFields) =>
  <A, E, R>(effect: Effect.Effect<A, E, R>): Effect.Effect<A, E, R> =>
    needsFiberContext(fields)
      ? Effect.suspend(() => annotateWith(effect, fields))
      : annotateWith(effect, fields);

/**
 * Annotates the current scope with `fields`. A set of only `undefined` values is a no-op. A
 * `Redactable` record (Effect's `Headers`) is resolved when the effect runs. A record whose keys
 * cannot be listed adds no annotations.
 */
export const withLogContextScoped = (fields: LogFields): Effect.Effect<void, never, Scope.Scope> =>
  needsFiberContext(fields)
    ? Effect.suspend(() => annotateScopedWith(fields))
    : annotateScopedWith(fields);

/**
 * Annotates the current scope with the compacted `fields`.
 */
const annotateScopedWith = (fields: LogFields): Effect.Effect<void, never, Scope.Scope> => {
  const compacted = compactLogFields(fields);
  if (Object.keys(compacted).length === 0) {
    return Effect.void;
  }

  return Effect.annotateLogsScoped(compacted);
};

/**
 * Writes one line at `level`. Optional fields are annotations. An optional cause is attached.
 */
export const logWithFields = (
  level: LogLevel.Severity,
  message: string,
  fields?: LogFields,
  cause?: Cause.Cause<unknown>,
): Effect.Effect<void> => {
  const baseLog =
    cause !== undefined
      ? Effect.logWithLevel(level)(message, cause)
      : Effect.logWithLevel(level)(message);

  if (fields === undefined) {
    return baseLog;
  }

  return baseLog.pipe(withLogContext(fields));
};

/**
 * Writes a trace line. Hidden unless the minimum level is `Trace` or `All`.
 */
export const logTrace = (message: string, fields?: LogFields): Effect.Effect<void> =>
  logWithFields('Trace', message, fields);

/**
 * Writes a debug line. Hidden at the default `Info` minimum.
 */
export const logDebug = (message: string, fields?: LogFields): Effect.Effect<void> =>
  logWithFields('Debug', message, fields);

/**
 * Writes an info line. This is the default severity for operational events.
 */
export const logInfo = (message: string, fields?: LogFields): Effect.Effect<void> =>
  logWithFields('Info', message, fields);

/**
 * Writes a warning line. Use it for a degraded path that still completed.
 */
export const logWarning = (message: string, fields?: LogFields): Effect.Effect<void> =>
  logWithFields('Warn', message, fields);

/**
 * Writes an error line without a cause. Prefer `logFailure` when an error value exists.
 */
export const logError = (message: string, fields?: LogFields): Effect.Effect<void> =>
  logWithFields('Error', message, fields);

/**
 * Writes an error line and attaches `cause` so the formatter can extract a summary.
 */
export const logErrorCause = (
  message: string,
  cause: Cause.Cause<unknown>,
  fields?: LogFields,
): Effect.Effect<void> => logWithFields('Error', message, fields, cause);

/**
 * Writes an error line, attaches `error` as a fail cause, and adds `errorMessage`, `errorTag`,
 * `errorName`, and `errorStatus` when those can be read, from the redacted form of a `Redactable`
 * error. The fields are read when the effect runs, not when it is built, and reading them never
 * throws.
 */
export const logFailure = (
  message: string,
  error: unknown,
  fields?: LogFields,
): Effect.Effect<void> =>
  Effect.suspend(() =>
    logWithFields(
      'Error',
      message,
      { ...extractErrorFields(error), ...compactLogFields(fields ?? {}) },
      Cause.fail(error),
    ),
  );

/**
 * Writes a fatal line. An optional cause is attached and is not wrapped again.
 */
export const logFatal = (
  message: string,
  cause?: Cause.Cause<unknown>,
  fields?: LogFields,
): Effect.Effect<void> => logWithFields('Fatal', message, fields, cause);
