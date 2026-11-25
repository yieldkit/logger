import { Cause, Context } from 'effect';

import type { CredentialRules } from './credentials.ts';
import type { RedactedLogValue, RedactWalk } from './redact-walk.ts';

import {
  CIRCULAR_LOG_VALUE,
  MAX_REDACT_DEPTH,
  TRUNCATED_LOG_VALUE,
  UNSERIALIZABLE_LOG_VALUE,
  redactWalkValue,
  startWalk,
  withVisible,
} from './redact-walk.ts';

/**
 * The parts of an `Error` Effect's cause renderer reads: name, message, stack and `cause`. A plain
 * object of this shape renders exactly like the error it was copied from.
 */
interface RenderedError {
  /**
   * The error's `name`.
   */
  readonly name: string;

  /**
   * The error's `message`.
   */
  readonly message: string;

  /**
   * The error's `stack`, which the renderer prints in place of name and message when present.
   */
  readonly stack: string | undefined;

  /**
   * The error's `cause`, made safe the same way, when it has one.
   */
  readonly cause: SafeThrown | undefined;
}

/**
 * What a fail or die value, or a link of an `Error`'s cause chain, renders from once made safe.
 */
type SafeThrown = RenderedError | RedactedLogValue;

/**
 * Returns an `Error`'s `message` as text Effect can render. A string is kept, a missing message
 * becomes empty, and any other value (which Effect would print as raw JSON) is redacted like a log
 * field and written as JSON.
 */
const safeMessage = (walk: RedactWalk, message: unknown, depth: number): string => {
  if (typeof message === 'string') {
    return message;
  }

  if (message === undefined) {
    return '';
  }

  return JSON.stringify(redactWalkValue(walk, message, depth + 1));
};

/**
 * Returns what a fail or die value may render as: a `Redactable` value's redacted form, then an
 * `Error` copied as {@link RenderedError} with its `cause` chain made safe the same way (cycles
 * cut, capped at {@link MAX_REDACT_DEPTH} levels), and any other value redacted like a log field.
 * The text of an `Error` is kept as it is here; it is scrubbed once after rendering. Never throws.
 */
const safeThrown = (walk: RedactWalk, value: unknown, depth: number): SafeThrown =>
  withVisible(value, (visible): SafeThrown => {
    try {
      if (!(visible instanceof Error)) {
        return redactWalkValue(walk, visible, depth);
      }

      if (walk.ancestors.has(visible)) {
        return CIRCULAR_LOG_VALUE;
      }

      if (depth > MAX_REDACT_DEPTH) {
        return TRUNCATED_LOG_VALUE;
      }

      walk.ancestors.add(visible);
      try {
        const nested: unknown = visible.cause;
        return {
          name: visible.name,
          message: safeMessage(walk, visible.message, depth),
          stack: visible.stack,
          cause: nested === undefined ? undefined : safeThrown(walk, nested, depth + 1),
        };
      } finally {
        walk.ancestors.delete(visible);
      }
    } catch {
      return UNSERIALIZABLE_LOG_VALUE;
    }
  });

/**
 * Builds an `Error` without capturing a stack trace, which its caller replaces anyway; capturing
 * one costs more than the rest of the stand-in. Where `Error.stackTraceLimit` cannot be set (a
 * locked-down runtime), the trace is captured as usual.
 */
const errorWithoutTrace = (message: string): Error => {
  const limit = Error.stackTraceLimit;
  try {
    Error.stackTraceLimit = 0;
  } catch {
    return new Error(message);
  }

  try {
    return new Error(message);
  } finally {
    Error.stackTraceLimit = limit;
  }
};

/**
 * Renders one fail or die value, with its value made safe (see {@link safeThrown}) and its stack
 * frames, the way Effect renders it with `includeCauseInStack`, then scrubs that text once with
 * `rules`. The result is an `Error` whose `stack`, `message` and `name` are scrubbed, so rendering
 * it again (by a logger, or by `Cause.prettyErrors` in an OTLP exporter) prints the same text.
 */
const renderScrubbed = (
  rules: CredentialRules,
  reason: Cause.Fail<unknown> | Cause.Die,
  value: unknown,
): Error => {
  const safe = safeThrown(startWalk(rules), value, 0);
  const annotations = Cause.reasonAnnotations(reason);
  const pretty = Cause.prettyErrors(
    Cause.fromReasons([Cause.makeDieReason(safe).annotate(annotations)]),
    { includeCauseInStack: true },
  )[0];
  const message = rules.redactText(pretty?.message ?? '');
  const standIn = errorWithoutTrace(message);
  standIn.name = rules.redactText(pretty?.name ?? 'Error');
  standIn.stack = rules.redactText(pretty?.stack ?? `${standIn.name}: ${message}`);
  return standIn;
};

/**
 * Returns `cause` with every fail and die value replaced by a stand-in `Error` that renders as the
 * original reason did, after its value was made safe and the rendered text was scrubbed once with
 * `rules` (see {@link renderScrubbed}). The stack frames are part of that text, so the stand-in
 * drops the `Cause.StackTrace` annotation and keeps the others. Interrupt reasons and an empty
 * cause are kept as they are. Sanitizing a sanitized cause gives the same rendering.
 */
export const sanitizeCauseWith = (
  rules: CredentialRules,
  cause: Cause.Cause<unknown>,
): Cause.Cause<unknown> => {
  if (cause.reasons.length === 0) {
    return cause;
  }

  return Cause.fromReasons(
    cause.reasons.map((reason): Cause.Reason<unknown> => {
      if (Cause.isInterruptReason(reason)) {
        return reason;
      }

      const value = Cause.isFailReason(reason) ? reason.error : reason.defect;
      const standIn = renderScrubbed(rules, reason, value);
      const annotations = Context.omit(Cause.StackTrace)(Cause.reasonAnnotations(reason));
      const replaced = Cause.isFailReason(reason)
        ? Cause.makeFailReason(standIn)
        : Cause.makeDieReason(standIn);
      return replaced.annotate(annotations);
    }),
  );
};
