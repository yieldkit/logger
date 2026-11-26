import type { Fiber } from 'effect';

import { Cause, Context, Exit, Logger, References, Tracer } from 'effect';

import type { CredentialRules, RedactionOptions } from './credentials.ts';
import type { RedactedLogRecord, RedactedLogValue } from './redact-walk.ts';

import { makeCredentialRules } from './credentials.ts';
import { sanitizeCauseWith } from './redact-cause.ts';
import {
  redactWalkRecord,
  redactWalkEntry,
  redactWalkValue,
  startWalk,
  UNSERIALIZABLE_LOG_VALUE,
  withVisible,
} from './redact-walk.ts';

export {
  type RedactedLogRecord,
  type RedactedLogValue,
  UNSERIALIZABLE_LOG_VALUE,
} from './redact-walk.ts';

/**
 * Every redaction step, bound to one set of sensitive names and text rules. Build one with
 * {@link makeLogRedaction} to add key names to the built-in lists; the module-level functions
 * ({@link redactLogValue}, {@link sanitizeCause}, {@link withRedaction}, ...) use the built-in lists.
 */
export interface LogRedaction {
  /**
   * Masks the convenience shapes in `text`, then runs `scrubText`. See `redactLogString`.
   */
  readonly redactString: (text: string) => string;

  /**
   * Returns a deep copy of `value` that is safe to log. See {@link redactLogValue}.
   */
  readonly redactValue: (value: unknown) => RedactedLogValue;

  /**
   * Returns `cause` with every fail and die made safe to render. See {@link sanitizeCause}.
   */
  readonly sanitizeCause: (cause: Cause.Cause<unknown>) => Cause.Cause<unknown>;

  /**
   * Returns logger options with the message, cause, annotations and log span labels redacted.
   */
  readonly redactLogOptions: (options: Logger.Options<unknown>) => Logger.Options<unknown>;

  /**
   * Wraps a logger so it only ever sees redacted input. See {@link withRedaction}.
   */
  readonly withRedaction: <Output>(
    logger: Logger.Logger<unknown, Output>,
  ) => Logger.Logger<unknown, Output>;

  /**
   * Wraps a tracer so its spans store redacted names, attributes and failure causes. See
   * {@link withTracerRedaction}.
   */
  readonly withTracerRedaction: (tracer: Tracer.Tracer) => Tracer.Tracer;
}

/**
 * Returns a proxy of `fiber` that answers from `overrides` for the references it holds, both
 * through `getRef` and through `fiber.context` (also when read with
 * `Object.getOwnPropertyDescriptor`), and from the real fiber for every other reference. The
 * overridden `context` is the real one with `overrides` merged in; it is built on the first read
 * and reused, so a logger that never reads `fiber.context` pays nothing for it. The real fiber's
 * context is never changed. Every other property is read from the real fiber, and methods are bound
 * to it, so `fiber.id` and `fiber.cache.span` keep working.
 */
export const overrideFiberRefs = (
  fiber: Fiber.Fiber<unknown, unknown>,
  overrides: Context.Context<never>,
): Fiber.Fiber<unknown, unknown> => {
  let merged: Context.Context<never> | undefined;

  /**
   * The real fiber's context with `overrides` merged in, built once on first use.
   */
  const mergedContext = (): Context.Context<never> => {
    merged ??= Context.merge(fiber.context, overrides);
    return merged;
  };

  return new Proxy(fiber, {
    get: (target, property) => {
      if (property === 'getRef') {
        return <A>(ref: Context.Reference<A>): A =>
          overrides.mapUnsafe.has(ref.key) ? Context.get(overrides, ref) : target.getRef(ref);
      }

      if (property === 'context') {
        return mergedContext();
      }

      const member: unknown = Reflect.get(target, property, target);
      if (typeof member !== 'function') {
        return member;
      }

      return (...args: ReadonlyArray<unknown>): unknown => Reflect.apply(member, target, args);
    },
    getOwnPropertyDescriptor: (target, property) => {
      const descriptor = Reflect.getOwnPropertyDescriptor(target, property);
      if (property !== 'context' || descriptor === undefined || !descriptor.configurable) {
        return descriptor;
      }

      return { ...descriptor, value: mergedContext() };
    },
  });
};

/**
 * Span members the redacting tracer replaces with redacting versions.
 */
type RedactedSpanMember = 'end' | 'attribute' | 'event' | 'addLinks';

/**
 * Names of the span members the redacting tracer replaces.
 */
const REDACTED_SPAN_MEMBERS: ReadonlySet<PropertyKey> = new Set<RedactedSpanMember>([
  'end',
  'attribute',
  'event',
  'addLinks',
]);

/**
 * Tells whether a property read on a span proxy must be answered by a redacting override.
 */
const isRedactedSpanMember = (property: PropertyKey): property is RedactedSpanMember =>
  REDACTED_SPAN_MEMBERS.has(property);

/**
 * Redacts a record of log annotations or span, event or link attributes, keyed like log fields. A
 * `Redactable` record (Effect `Headers`) is replaced by its redacted form first, and a form that is
 * not an object gives an empty record. The record is copied entry by entry, so an entry named
 * `toJSON` stays data, and entries past the item limit become one `[more]` marker. A record whose
 * keys cannot be listed gives an empty record.
 */
const redactAttributes = (
  rules: CredentialRules,
  attributes: Readonly<Record<string, unknown>>,
): RedactedLogRecord => {
  try {
    return withVisible(attributes, (visible) =>
      typeof visible === 'object' && visible !== null
        ? redactWalkRecord(startWalk(rules), visible, 0)
        : {},
    );
  } catch {
    return {};
  }
};

/**
 * Returns copies of `links` whose attributes are redacted like span attributes. The linked span is
 * kept as it is.
 */
const redactLinks = (
  rules: CredentialRules,
  links: ReadonlyArray<Tracer.SpanLink>,
): Array<Tracer.SpanLink> =>
  links.map((link) => ({ ...link, attributes: redactAttributes(rules, link.attributes) }));

/**
 * Returns a proxy of `span` whose `end`, `attribute`, `event` and `addLinks` redact their input
 * before passing it on. Other members are read from the real span, and methods are bound to it.
 */
const redactSpan = (rules: CredentialRules, span: Tracer.Span): Tracer.Span => {
  const overrides: Pick<Tracer.Span, RedactedSpanMember> = {
    end: (endTime, exit) => {
      const safeExit = Exit.isFailure(exit)
        ? Exit.failCause(sanitizeCauseWith(rules, exit.cause))
        : exit;
      span.end(endTime, safeExit);
    },
    attribute: (key, value) => {
      span.attribute(key, redactWalkEntry(startWalk(rules), key, value, 0));
    },
    event: (name, startTime, attributes) => {
      const redacted = attributes === undefined ? undefined : redactAttributes(rules, attributes);
      span.event(rules.redactText(name), startTime, redacted);
    },
    addLinks: (links) => {
      span.addLinks(redactLinks(rules, links));
    },
  };
  return new Proxy(span, {
    get: (target, property) => {
      if (isRedactedSpanMember(property)) {
        return overrides[property];
      }

      const member: unknown = Reflect.get(target, property, target);
      if (typeof member !== 'function') {
        return member;
      }

      return (...args: ReadonlyArray<unknown>): unknown => Reflect.apply(member, target, args);
    },
  });
};

/**
 * Wraps `tracer` so the spans it builds store data redacted with `rules`: span and event names go
 * through `rules.redactText`, attributes are redacted like log fields (keys written as they are),
 * and a failed span's cause is sanitized.
 */
export const withTracerRedactionWith = (
  rules: CredentialRules,
  tracer: Tracer.Tracer,
): Tracer.Tracer =>
  Tracer.make({
    span: (spanOptions) =>
      redactSpan(
        rules,
        tracer.span({
          ...spanOptions,
          name: rules.redactText(spanOptions.name),
          links: redactLinks(rules, spanOptions.links),
        }),
      ),
    context: tracer.context,
  });

/**
 * Returns `logOptions` with the message, cause, log annotations and log span labels redacted with
 * `rules`. The annotations are copied like span attributes (see {@link redactAttributes}), so an
 * annotation named `toJSON` stays data and a `Headers` record is masked. Annotations and span
 * labels are served through a fiber proxy, so loggers that read them with `fiber.getRef` or from
 * `fiber.context` see the redacted values.
 */
const redactOptionsWith = (
  rules: CredentialRules,
  logOptions: Logger.Options<unknown>,
): Logger.Options<unknown> => {
  const fiber = logOptions.fiber;
  const annotations = redactAttributes(rules, fiber.getRef(References.CurrentLogAnnotations));
  const spans = fiber
    .getRef(References.CurrentLogSpans)
    .map(([label, startTime]): [label: string, timestamp: number] => [
      rules.redactText(label),
      startTime,
    ]);
  const overrides = Context.makeUnsafe(
    new Map<string, unknown>([
      [References.CurrentLogAnnotations.key, annotations],
      [References.CurrentLogSpans.key, spans],
    ]),
  );
  return {
    ...logOptions,
    message: redactWalkValue(startWalk(rules), logOptions.message, 0),
    cause: sanitizeCauseWith(rules, logOptions.cause),
    fiber: overrideFiberRefs(fiber, overrides),
  };
};

/**
 * Returns `options` reduced to what can always be logged: the string parts of the message (Effect
 * passes the message as an array) with every other part replaced by
 * {@link UNSERIALIZABLE_LOG_VALUE}, no cause, and no log annotations or log spans.
 */
const fallbackOptions = (options: Logger.Options<unknown>): Logger.Options<unknown> => {
  const parts: ReadonlyArray<unknown> = Array.isArray(options.message)
    ? options.message
    : [options.message];
  const empty = Context.makeUnsafe(
    new Map<string, unknown>([
      [References.CurrentLogAnnotations.key, {}],
      [References.CurrentLogSpans.key, []],
    ]),
  );
  return {
    ...options,
    message: parts.map((part) => (typeof part === 'string' ? part : UNSERIALIZABLE_LOG_VALUE)),
    cause: Cause.empty,
    fiber: overrideFiberRefs(options.fiber, empty),
  };
};

/**
 * Wraps `logger` so a line it cannot redact, format or write never fails the fiber that logged it;
 * Effect calls loggers without catching. When `logger` throws, it is called once more with only the
 * string parts of the message, no cause and no annotations or log spans, so the event name is still
 * written; when that throws too, the line is dropped. `makeLoggerLayer`, `LoggerLive` and
 * `makeTestLogger` guard every logger they install.
 */
export const guardLogger = (logger: Logger.Logger<unknown, void>): Logger.Logger<unknown, void> =>
  Logger.make((options) => {
    try {
      logger.log(options);
    } catch {
      try {
        logger.log(fallbackOptions(options));
      } catch {
        // Nothing is left to write; dropping the line keeps the caller's fiber alive.
      }
    }
  });

/**
 * Builds a {@link LogRedaction} whose rules are the built-in sensitive names plus `options`. Pass
 * `options` as `redaction` to `makeLoggerLayer`, `LoggerLive`, `telemetryLayer` and
 * `makeTestLogger` to use the same rules there.
 */
export const makeLogRedaction = (options: RedactionOptions = {}): LogRedaction => {
  const rules = makeCredentialRules(options);
  const redactLogOptions = sharedPerLine((logOptions) => redactOptionsWith(rules, logOptions));
  return {
    redactString: rules.redactText,
    redactValue: (value) => redactWalkValue(startWalk(rules), value, 0),
    sanitizeCause: (cause) => sanitizeCauseWith(rules, cause),
    redactLogOptions,
    withRedaction: (logger) =>
      Logger.make((logOptions) => logger.log(redactLogOptions(logOptions))),
    withTracerRedaction: (tracer) => withTracerRedactionWith(rules, tracer),
  };
};

/**
 * One line's logger options, as compared by {@link sharedPerLine}: what Effect passes to every
 * logger of one log call, and the log annotations and span labels read from the fiber.
 */
interface LineIdentity {
  /**
   * The options one logger received.
   */
  readonly options: Logger.Options<unknown>;

  /**
   * The fiber's log annotations when the options were redacted.
   */
  readonly annotations: unknown;

  /**
   * The fiber's log spans when the options were redacted.
   */
  readonly spans: unknown;
}

/**
 * Wraps `redact` so the loggers of one log call share its result. Effect hands every logger of one
 * call a fresh options object holding the same `Date`, fiber, message and cause, so the result is
 * remembered under that `Date` (weakly, so nothing outlives the line) and reused when another
 * logger brings the same `Date`, fiber, message, cause, level, annotations and span list. Anything
 * else is redacted afresh.
 */
const sharedPerLine = (
  redact: (options: Logger.Options<unknown>) => Logger.Options<unknown>,
): ((options: Logger.Options<unknown>) => Logger.Options<unknown>) => {
  const recent = new WeakMap<
    Date,
    { readonly line: LineIdentity; readonly redacted: Logger.Options<unknown> }
  >();
  return (options) => {
    const line: LineIdentity = {
      options,
      annotations: options.fiber.getRef(References.CurrentLogAnnotations),
      spans: options.fiber.getRef(References.CurrentLogSpans),
    };
    const remembered = recent.get(options.date);
    if (remembered !== undefined && isSameLine(remembered.line, line)) {
      return remembered.redacted;
    }

    const redacted = redact(options);
    recent.set(options.date, { line, redacted });
    return redacted;
  };
};

/**
 * Tells whether two loggers received the same line: the same fiber, message, cause and level, and
 * the same annotations and span list (by identity; Effect replaces them rather than changing
 * them).
 */
const isSameLine = (first: LineIdentity, second: LineIdentity): boolean =>
  first.options.fiber === second.options.fiber &&
  first.options.message === second.options.message &&
  first.options.cause === second.options.cause &&
  first.options.logLevel === second.options.logLevel &&
  first.annotations === second.annotations &&
  first.spans === second.spans;

/**
 * The redaction with only the built-in sensitive names, behind every module-level function here.
 */
export const defaultLogRedaction: LogRedaction = makeLogRedaction();

/**
 * Returns a deep copy of `value` that is safe to log, using the built-in sensitive names. The input
 * is never modified, and the call never throws. What is masked is decided by type and key name,
 * never by the content of a string or the shape of a container:
 *
 * - A `Redactable` value (Effect's `[Redactable.symbolRedactable]` protocol, Effect `Headers` among
 *   them) is replaced by its redacted form, which is then redacted the same way. Effect `Redacted`
 *   values are returned as they are, so they print `<redacted>`; an object that only claims to be
 *   `Redacted` (the marker key without the prototype) becomes `<redacted>`.
 * - Under a key that contains a built-in sensitive name (see `isSensitiveLogKey`), a value is written
 *   as `<redacted>` unless it is a `number`, a `boolean`, `null` or `undefined`.
 * - Strings go through `redactLogString`. Other primitives and `Date` are returned as they are; a
 *   `Date` subclass is copied to a plain `Date`. A function becomes `[Function]`.
 * - An `Error` becomes `{ name, message, ...own enumerable properties, cause }` without its stack. An
 *   object with `toJSON` is replaced by its redacted `toJSON()` result. A `Map` becomes a plain
 *   object keyed by `String(key)`, a `Set` an array, and other objects contribute their own
 *   enumerable string-keyed properties. Keys are written as they are.
 * - Binary data (`ArrayBuffer`, typed arrays, `DataView`, `Buffer`) becomes `[Uint8Array 4096
 *   bytes]`.
 * - A reference to an ancestor becomes `[Circular]`, nesting deeper than 8 levels `[Truncated]`. Only
 *   the first 1,000 items of an array or `Set` are copied, then `[n more items]`, and the first
 *   1,000 entries of a `Map` or object, then a `[more]: '[n more entries]'` entry. After 10,000
 *   values (masked ones included) the walk stops: the rest of the array becomes one `[Truncated]`
 *   item and the rest of the record one `[more]: '[Truncated]'` entry.
 * - A value that cannot be read (a throwing getter or `toJSON`, a revoked `Proxy`, a key whose
 *   `toString` throws) becomes `[Unserializable]`.
 */
export const redactLogValue = (value: unknown): RedactedLogValue =>
  defaultLogRedaction.redactValue(value);

/**
 * Returns `cause` with every fail and die value replaced by a stand-in `Error` that renders like
 * the original, using the built-in sensitive names. Before rendering, a `Redactable` value is
 * replaced by its redacted form, a value that is not an `Error` goes through {@link redactLogValue},
 * and an `Error`'s `cause` chain is treated the same way (cycles cut, at most 8 levels). The
 * rendered text, stack frames included, is then scrubbed once with `redactLogString`. Interrupt
 * reasons and an empty cause are returned as they are.
 */
export const sanitizeCause = (cause: Cause.Cause<unknown>): Cause.Cause<unknown> =>
  defaultLogRedaction.sanitizeCause(cause);

/**
 * Wraps `logger` so it only ever sees redacted input: the message goes through
 * {@link redactLogValue}, the cause through {@link sanitizeCause}, and log annotations and log span
 * labels come back redacted, whether read with `fiber.getRef` or from `fiber.context`. Other
 * services in `fiber.context` are passed as they are. Use it for loggers that render options
 * themselves, such as `Logger.formatLogFmt`, `Logger.consolePretty` and `Logger.tracerLogger`. Uses
 * the built-in sensitive names; see {@link makeLogRedaction} for more.
 */
export const withRedaction = <Output>(
  logger: Logger.Logger<unknown, Output>,
): Logger.Logger<unknown, Output> => defaultLogRedaction.withRedaction(logger);

/**
 * Wraps `tracer` so the spans it builds store redacted names, attributes and failure causes. A
 * failed span ends with its cause passed through {@link sanitizeCause}, so exporters that render the
 * exit (status message, `exception` events and stack traces) see no secret. Span names and event
 * names go through `redactLogString`. Span attributes and event attributes are redacted like log
 * annotations, by key name and type (see {@link redactLogValue}), with their keys written as they
 * are. Span link attributes, whether passed when the span is created or added later with
 * `addLinks`, are redacted the same way. A successful span's exit value is passed on unchanged.
 * Every other span member is read from the real span. Uses the built-in sensitive names; see
 * {@link makeLogRedaction} for more.
 */
export const withTracerRedaction = (tracer: Tracer.Tracer): Tracer.Tracer =>
  defaultLogRedaction.withTracerRedaction(tracer);

/**
 * Returns `options` with the message, cause, annotations and log span labels redacted, using the
 * built-in sensitive names. Shared by {@link withRedaction} and the structured logger.
 */
export const redactLogOptions = (options: Logger.Options<unknown>): Logger.Options<unknown> =>
  defaultLogRedaction.redactLogOptions(options);
