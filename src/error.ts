import { Cause, Formatter, Predicate } from 'effect';

import type { LogRedaction } from './redact.ts';
import type { ErrorSummary, LogFields } from './types.ts';

import { omitUndefined } from './omit-undefined.ts';
import { FUNCTION_LOG_VALUE, withVisible } from './redact-walk.ts';
import { defaultLogRedaction, UNSERIALIZABLE_LOG_VALUE } from './redact.ts';

/**
 * Reads a non-empty string property of an object. Missing, non-string, and empty values, and a
 * property that throws when read, are omitted.
 */
const readNonEmptyStringProp = (value: unknown, key: string): string | undefined => {
  try {
    if (!Predicate.hasProperty(value, key)) {
      return undefined;
    }

    const candidate = value[key];
    return typeof candidate === 'string' && candidate.length > 0 ? candidate : undefined;
  } catch {
    return undefined;
  }
};

/**
 * Reads a finite number property of an object. Missing and non-finite values, and a property that
 * throws when read, are omitted.
 */
const readFiniteNumberProp = (value: unknown, key: string): number | undefined => {
  try {
    if (!Predicate.hasProperty(value, key)) {
      return undefined;
    }

    const candidate = value[key];
    return typeof candidate === 'number' && Number.isFinite(candidate) ? candidate : undefined;
  } catch {
    return undefined;
  }
};

/**
 * Tells whether `value` is an `Error`. A revoked `Proxy`, which throws on the check, is not.
 */
const isError = (value: unknown): value is Error => {
  try {
    return value instanceof Error;
  } catch {
    return false;
  }
};

/**
 * Reads the class name of an object, or `undefined` for a plain object, a null-prototype object or
 * one whose prototype cannot be read.
 */
const className = (value: unknown): string | undefined => {
  try {
    const prototype: unknown =
      typeof value === 'object' && value !== null ? Reflect.getPrototypeOf(value) : undefined;
    if (!Predicate.hasProperty(prototype, 'constructor')) {
      return undefined;
    }

    const name: unknown = Predicate.hasProperty(prototype.constructor, 'name')
      ? prototype.constructor.name
      : undefined;
    return typeof name === 'string' && name !== '' && name !== 'Object' ? name : undefined;
  } catch {
    return undefined;
  }
};

/**
 * Renders an object that has no message or tag: its redacted JSON form, after the class name when
 * it has one (`Credentials {"user":"u","password":"<redacted>"}`). The object's own `toString` is
 * never called, because it may print the fields it holds.
 */
const describeObject = (error: unknown, redaction: LogRedaction): string => {
  const redacted = redaction.redactValue(error);
  const json = typeof redacted === 'string' ? redacted : Formatter.formatJson(redacted);
  const name = className(error);
  return name === undefined ? json : `${name} ${json}`;
};

/**
 * {@link describeError} with the given rules for the JSON form of a plain object.
 */
const describeErrorWith = (error: unknown, redaction: LogRedaction): string =>
  withVisible(error, (visible) => describeVisibleError(visible, redaction));

/**
 * Returns the message a value carries itself: an `Error`'s message (or name, or `Error`), another
 * object's `message` or `_tag` string, or `String(value)` for a primitive. Returns `undefined` for
 * an object that has neither, whose only description is its JSON form.
 */
const ownDescription = (error: unknown): string | undefined => {
  if (isError(error)) {
    const message = readNonEmptyStringProp(error, 'message');
    return message ?? readNonEmptyStringProp(error, 'name') ?? 'Error';
  }

  if (typeof error === 'object' && error !== null) {
    return readNonEmptyStringProp(error, 'message') ?? readNonEmptyStringProp(error, '_tag');
  }

  if (typeof error === 'function') {
    return FUNCTION_LOG_VALUE;
  }

  try {
    return String(error);
  } catch {
    return UNSERIALIZABLE_LOG_VALUE;
  }
};

/**
 * Describes a value that is already its own redacted form. See {@link describeError}.
 */
const describeVisibleError = (error: unknown, redaction: LogRedaction): string =>
  ownDescription(error) ?? describeObject(error, redaction);

/**
 * Returns a message for an unknown error, and never throws. A `Redactable` value is described by
 * its redacted form. An `Error` gives its message, or its name when the message is empty. Another
 * object gives its `message` or `_tag` string, or else its JSON form with sensitive keys masked
 * (see `redactLogValue`), after its class name, such as `Credentials
 * {"user":"u","password":"<redacted>"}`. Its own `toString` is never called. Other values give
 * `String(value)`. The result is not passed through `redactLogString`; callers that log it should
 * do that.
 */
export const describeError = (error: unknown): string =>
  describeErrorWith(error, defaultLogRedaction);

/**
 * Reads `Error.name` or a non-empty `name` string. Other values are omitted.
 */
const readErrorName = (error: unknown): string | undefined => {
  if (isError(error)) {
    return readNonEmptyStringProp(error, 'name');
  }

  return typeof error === 'object' && error !== null
    ? readNonEmptyStringProp(error, 'name')
    : undefined;
};

/**
 * Builds a fail or die summary from `message`, `_tag`, `name`, and `status` when present, read from
 * the redacted form of a `Redactable` value. The message, tag and name go through `redactText` (the
 * convenience shapes and `scrubText`).
 */
const buildErrorSummary = (
  kind: 'fail' | 'die',
  thrown: unknown,
  redaction: LogRedaction,
): ErrorSummary => withVisible(thrown, (error) => buildVisibleSummary(kind, error, redaction));

/**
 * Reads the tag, name and status of a value that is already its own redacted form, with the tag and
 * name masked by `redaction.redactString`.
 */
const summaryDetails = (
  error: unknown,
  redaction: LogRedaction,
): Pick<ErrorSummary, 'tag' | 'name' | 'status'> => {
  const tag = readNonEmptyStringProp(error, '_tag');
  const name = readErrorName(error);
  return omitUndefined({
    tag: tag === undefined ? undefined : redaction.redactString(tag),
    name: name === undefined ? undefined : redaction.redactString(name),
    status: readFiniteNumberProp(error, 'status'),
  });
};

/**
 * {@link buildErrorSummary} for a value that is already its own redacted form.
 */
const buildVisibleSummary = (
  kind: 'fail' | 'die',
  error: unknown,
  redaction: LogRedaction,
): ErrorSummary => ({
  kind,
  message: redaction.redactString(describeVisibleError(error, redaction)),
  ...summaryDetails(error, redaction),
});

/**
 * Returns annotation fields for `error`, read from the redacted form of a `Redactable` value:
 * `errorMessage`, `errorTag`, `errorName` and `errorStatus`, each when present. The message, tag
 * and name are masked with `redactLogString`. An object with no `message` or `_tag` gets no
 * `errorMessage`: its JSON form is redacted with the built-in names only, so it could reveal a
 * value under a name the logger layer adds, and the line's cause already carries that object
 * redacted with the layer's rules. Never throws.
 */
export const extractErrorFields = (error: unknown): LogFields =>
  withVisible(error, (visible) => {
    const message = ownDescription(visible);
    const { tag, name, status } = summaryDetails(visible, defaultLogRedaction);
    return omitUndefined({
      errorMessage: message === undefined ? undefined : defaultLogRedaction.redactString(message),
      errorTag: tag,
      errorName: name,
      errorStatus: status,
    });
  });

/**
 * {@link extractCauseSummary} with the given rules.
 */
export const summarizeCause = (
  cause: Cause.Cause<unknown>,
  redaction: LogRedaction,
): ErrorSummary | undefined => {
  if (cause.reasons.length === 0) {
    return undefined;
  }

  const failReason = cause.reasons.find(Cause.isFailReason);
  if (failReason !== undefined) {
    return buildErrorSummary('fail', failReason.error, redaction);
  }

  const dieReason = cause.reasons.find(Cause.isDieReason);
  if (dieReason !== undefined) {
    return buildErrorSummary('die', dieReason.defect, redaction);
  }

  const interruptReason = cause.reasons.find(Cause.isInterruptReason);
  if (interruptReason !== undefined) {
    return {
      kind: 'interrupt',
      message: 'Fiber interrupted',
      ...omitUndefined({ fiberId: interruptReason.fiberId }),
    };
  }

  return undefined;
};

/**
 * Returns the first fail, otherwise the first die, otherwise the first interrupt. An empty cause
 * returns `undefined`. The summary's message, tag and name are masked with `redactLogString`.
 */
export const extractCauseSummary = (cause: Cause.Cause<unknown>): ErrorSummary | undefined =>
  summarizeCause(cause, defaultLogRedaction);
