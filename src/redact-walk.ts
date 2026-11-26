import { Redactable, Redacted } from 'effect';

import type { CredentialRules } from './credentials.ts';

import { REDACTED_LOG_VALUE } from './credentials.ts';

/**
 * Written in place of an object that is already being copied higher up the same path.
 */
export const CIRCULAR_LOG_VALUE = '[Circular]';

/**
 * Written in place of a value nested deeper than {@link MAX_REDACT_DEPTH}, or reached after the
 * walk used up {@link MAX_REDACT_NODES}.
 */
export const TRUNCATED_LOG_VALUE = '[Truncated]';

/**
 * Written in place of a value that cannot be read or copied: a `toJSON` or getter that throws, a
 * revoked `Proxy`, or a key that cannot be turned into a string.
 */
export const UNSERIALIZABLE_LOG_VALUE = '[Unserializable]';

/**
 * Written in place of a function, so its source text is never written and a callable `Proxy` never
 * reaches a formatter.
 */
export const FUNCTION_LOG_VALUE = '[Function]';

/**
 * Deepest nesting level that is copied. Anything below it becomes {@link TRUNCATED_LOG_VALUE}, so a
 * huge or pathological value cannot make one log call recurse without bound.
 */
export const MAX_REDACT_DEPTH = 8;

/**
 * Most values one walk visits, masked values included. When it runs out, the rest of the array or
 * record being copied is replaced by one {@link TRUNCATED_LOG_VALUE}, so the cost of one log call
 * stays bounded whatever the value's shape.
 */
export const MAX_REDACT_NODES = 10_000;

/**
 * Most items copied from one array or `Set`, and entries from one `Map`, `Error` or object. The
 * rest is summarized by one marker (`[4000 more items]`).
 */
export const MAX_REDACT_ITEMS = 1000;

/**
 * The one key that a plain assignment would treat as the prototype instead of data.
 */
const PROTO_KEY = '__proto__';

/**
 * Key of the marker entry added to a record whose entries were cut at {@link MAX_REDACT_ITEMS}.
 */
const MORE_ENTRIES_KEY = '[more]';

/**
 * Most `Redactable` layers unwrapped in a row, in case a redacted form is itself `Redactable`.
 */
const MAX_REDACTABLE_UNWRAPS = 3;

/**
 * Prototype shared by every real `Redacted` value. An object that only carries the
 * `~effect/Redacted` key (such as parsed JSON) does not have it.
 */
const REDACTED_PROTOTYPE: unknown = Object.getPrototypeOf(Redacted.make(''));

/**
 * A value after redaction: strings are masked, other primitives, plain `Date` and `Redacted` values
 * pass through, a function has become {@link FUNCTION_LOG_VALUE}, and every other object has become
 * a plain array or record whose members are redacted the same way. It holds no `Error`, `Map` or
 * `Set`, and no object with `toJSON` other than a `Date`.
 */
export type RedactedLogValue =
  | string
  | number
  | boolean
  | bigint
  | symbol
  | null
  | undefined
  | Date
  | Redacted.Redacted<unknown>
  | ReadonlyArray<RedactedLogValue>
  | RedactedLogRecord;

/**
 * Plain object built by the redaction walk: own string keys, each holding a redacted value.
 */
export interface RedactedLogRecord {
  readonly [key: string]: RedactedLogValue;
}

/**
 * State of one redaction walk: the rules it applies, the objects it has reached, and its remaining
 * node budget.
 */
export interface RedactWalk {
  /**
   * Key and text rules.
   */
  readonly rules: CredentialRules;

  /**
   * Objects being copied on the current path from the root, to cut cycles.
   */
  readonly ancestors: Set<object>;

  /**
   * Values the walk may still visit before it truncates. See {@link MAX_REDACT_NODES}.
   */
  remainingNodes: number;
}

/**
 * An object reached by the redaction walk, before its kind is known. Only `toJSON` is read from it
 * by name; every other member is reached through the rule for its kind.
 */
interface WalkedObject {
  /**
   * Custom serializer, when the object has one. Its type is checked before it is called.
   */
  readonly toJSON?: unknown;
}

/**
 * Starts a walk with `rules`, nothing visited and a full node budget.
 */
export const startWalk = (rules: CredentialRules): RedactWalk => ({
  rules,
  ancestors: new Set<object>(),
  remainingNodes: MAX_REDACT_NODES,
});

/**
 * Calls `read` with what may be logged of `value`: the redacted form of a `Redactable` value
 * (Effect's `[Redactable.symbolRedactable]` protocol, read in the current fiber's context),
 * unwrapped up to {@link MAX_REDACTABLE_UNWRAPS} times, or `value` itself. A form that is still
 * `Redactable` after that is passed as {@link TRUNCATED_LOG_VALUE}, and one that throws as
 * {@link UNSERIALIZABLE_LOG_VALUE}, so `read` never sees a `Redactable` value. This is the one
 * place every sink (the walk, causes, error summaries and log context) reveals a `Redactable`. It
 * throws only what `read` throws.
 */
export const withVisible = <A>(value: unknown, read: (visible: unknown) => A): A => {
  let visible = value;
  try {
    for (let unwraps = 0; Redactable.isRedactable(visible); unwraps += 1) {
      visible =
        unwraps >= MAX_REDACTABLE_UNWRAPS ? TRUNCATED_LOG_VALUE : Redactable.getRedacted(visible);
    }
  } catch {
    visible = UNSERIALIZABLE_LOG_VALUE;
  }

  return read(visible);
};

/**
 * Turns a `Map` key into the string written for it. A key whose `toString` throws becomes
 * {@link UNSERIALIZABLE_LOG_VALUE}.
 */
const mapKeyText = (key: unknown): string => {
  if (typeof key === 'string') {
    return key;
  }

  try {
    return String(key);
  } catch {
    return UNSERIALIZABLE_LOG_VALUE;
  }
};

/**
 * Reads the own enumerable string-keyed properties of `value` one at a time, so a getter that
 * throws hides only its own property (as {@link UNSERIALIZABLE_LOG_VALUE}).
 */
export const ownEntries = (
  value: WalkedObject | Error,
  limit = Number.POSITIVE_INFINITY,
): Array<readonly [string, unknown]> =>
  Object.keys(value)
    .slice(0, limit)
    .map((key) => {
      try {
        const descriptor = Object.getOwnPropertyDescriptor(value, key);
        const item: unknown =
          descriptor?.get === undefined ? descriptor?.value : descriptor.get.call(value);
        return [key, item] as const;
      } catch {
        return [key, UNSERIALIZABLE_LOG_VALUE] as const;
      }
    });

/**
 * Lists the properties copied from an Error: `name`, `message`, its own enumerable properties (up
 * to {@link MAX_REDACT_ITEMS}, excluding `stack`) and its `cause`. The runtime defines `cause` as
 * non-enumerable, so it is added explicitly.
 */
const errorEntries = (error: Error): Array<readonly [string, unknown]> => {
  const entries: Array<readonly [string, unknown]> = [
    ['name', error.name],
    ['message', error.message],
    ...ownEntries(error, MAX_REDACT_ITEMS).filter(([key]) => key !== 'stack'),
  ];
  if (Object.hasOwn(error, 'cause') && !Object.keys(error).includes('cause')) {
    entries.push(['cause', error.cause]);
  }

  return entries;
};

/**
 * Tells whether `value` is a primitive other than a string, which the walk returns as it is.
 */
const isPassThrough = (
  value: unknown,
): value is number | boolean | bigint | symbol | null | undefined =>
  typeof value === 'number' ||
  typeof value === 'boolean' ||
  typeof value === 'bigint' ||
  typeof value === 'symbol' ||
  value === undefined ||
  value === null;

/**
 * Redacts `value` at `depth`. Never throws: an object that cannot be read becomes
 * {@link UNSERIALIZABLE_LOG_VALUE}, and every value past the walk's node budget becomes
 * {@link TRUNCATED_LOG_VALUE}.
 */
export const redactWalkValue = (
  walk: RedactWalk,
  value: unknown,
  depth: number,
): RedactedLogValue => {
  walk.remainingNodes -= 1;
  if (walk.remainingNodes < 0) {
    return TRUNCATED_LOG_VALUE;
  }

  if (typeof value === 'string') {
    return walk.rules.redactText(value);
  }

  if (isPassThrough(value)) {
    return value;
  }

  try {
    return redactObjectValue(walk, value, depth);
  } catch {
    return UNSERIALIZABLE_LOG_VALUE;
  }
};

/**
 * Returns `[<type> <n> bytes]` for binary data (an `ArrayBuffer`, `SharedArrayBuffer`, typed array,
 * `DataView` or `Buffer`), or `undefined` for anything else. Binary data is summarized rather than
 * copied, because copying it costs one entry per byte.
 */
const binarySummary = (value: WalkedObject): string | undefined => {
  if (ArrayBuffer.isView(value)) {
    return `[${binaryTag(value)} ${String(value.byteLength)} bytes]`;
  }

  if (
    value instanceof ArrayBuffer ||
    (typeof SharedArrayBuffer === 'function' && value instanceof SharedArrayBuffer)
  ) {
    return `[${binaryTag(value)} ${String(value.byteLength)} bytes]`;
  }

  return undefined;
};

/**
 * Returns the built-in type name of binary data (`Uint8Array`, `DataView`, `ArrayBuffer`), which a
 * subclass such as Node's `Buffer` reports too.
 */
const binaryTag = (value: ArrayBufferView | ArrayBufferLike): string =>
  Object.prototype.toString.call(value).slice('[object '.length, -1);

/**
 * Redacts one object or function: a `Redactable` value is replaced by its redacted form (see
 * {@link withVisible}), then `Redacted` values, functions ({@link FUNCTION_LOG_VALUE}), `Date` and
 * binary values, then cycles and depth, then the rule for its kind. A `Date` subclass is copied to
 * a plain `Date`, so its own `toJSON` or `Symbol.toPrimitive` never runs in a formatter. Any step
 * may throw (a revoked `Proxy` throws on every check); the caller turns that into
 * {@link UNSERIALIZABLE_LOG_VALUE}.
 */
const redactObjectValue = (
  walk: RedactWalk,
  value: WalkedObject,
  depth: number,
): RedactedLogValue => {
  if (Redactable.isRedactable(value)) {
    return withVisible(value, (visible) => redactWalkValue(walk, visible, depth + 1));
  }

  if (Redacted.isRedacted(value)) {
    return Object.getPrototypeOf(value) === REDACTED_PROTOTYPE ? value : REDACTED_LOG_VALUE;
  }

  if (typeof value === 'function') {
    return FUNCTION_LOG_VALUE;
  }

  if (value instanceof Date) {
    return new Date(Date.prototype.getTime.call(value));
  }

  const binary = binarySummary(value);
  if (binary !== undefined) {
    return binary;
  }

  if (walk.ancestors.has(value)) {
    return CIRCULAR_LOG_VALUE;
  }

  if (depth > MAX_REDACT_DEPTH) {
    return TRUNCATED_LOG_VALUE;
  }

  walk.ancestors.add(value);
  try {
    return redactObject(walk, value, depth);
  } finally {
    walk.ancestors.delete(value);
  }
};

/**
 * Copies up to {@link MAX_REDACT_ITEMS} items of an array or `Set`, then a `[n more items]` marker.
 * Items are redacted by their own content; a list is never read as name/value pairs. When the
 * walk's budget runs out, the rest of the list becomes one {@link TRUNCATED_LOG_VALUE}.
 */
const redactItems = (
  walk: RedactWalk,
  items: ReadonlyArray<unknown>,
  total: number,
  depth: number,
): Array<RedactedLogValue> => {
  const copied: Array<RedactedLogValue> = [];
  for (let index = 0; index < items.length; index += 1) {
    if (walk.remainingNodes <= 0) {
      copied.push(TRUNCATED_LOG_VALUE);
      return copied;
    }

    copied.push(redactWalkValue(walk, items[index], depth + 1));
  }

  if (total > items.length) {
    copied.push(`[${String(total - items.length)} more items]`);
  }

  return copied;
};

/**
 * Returns the first {@link MAX_REDACT_ITEMS} values of `iterable` without reading the rest.
 */
const takeItems = <A>(iterable: Iterable<A>): Array<A> => {
  const taken: Array<A> = [];
  for (const item of iterable) {
    if (taken.length >= MAX_REDACT_ITEMS) {
      break;
    }

    taken.push(item);
  }

  return taken;
};

/**
 * Copies one object that is already on the ancestor path, picking the rule for its kind.
 */
const redactObject = (walk: RedactWalk, value: WalkedObject, depth: number): RedactedLogValue => {
  if (Array.isArray(value)) {
    const items: ReadonlyArray<unknown> = value;
    return redactItems(walk, items.slice(0, MAX_REDACT_ITEMS), items.length, depth);
  }

  if (value instanceof Error) {
    return redactWalkEntries(walk, errorEntries(value), depth);
  }

  if (value instanceof Map) {
    const entries = takeItems<[unknown, unknown]>(value).map(
      ([key, item]) => [mapKeyText(key), item] as const,
    );
    return withMoreEntries(redactWalkEntries(walk, entries, depth), value.size - entries.length);
  }

  if (value instanceof Set) {
    return redactItems(walk, takeItems<unknown>(value), value.size, depth);
  }

  const fromJson = redactToJson(walk, value, depth);
  if (fromJson !== undefined) {
    return fromJson.value;
  }

  return redactWalkRecord(walk, value, depth);
};

/**
 * Redacts the first {@link MAX_REDACT_ITEMS} own entries of `record` and marks the rest with a
 * `[more]` entry. Unlike {@link redactWalkValue}, it never calls the record's `toJSON`, so it suits
 * a value that is always a plain record, such as the log annotations.
 */
export const redactWalkRecord = (
  walk: RedactWalk,
  record: WalkedObject,
  depth: number,
): RedactedLogRecord =>
  withMoreEntries(
    redactWalkEntries(walk, ownEntries(record, MAX_REDACT_ITEMS), depth),
    Object.keys(record).length - MAX_REDACT_ITEMS,
  );

/**
 * Adds a `[more]: '[n more entries]'` marker to `record` when `more` entries were left out.
 */
const withMoreEntries = (record: RedactedLogRecord, more: number): RedactedLogRecord =>
  more > 0 ? { ...record, [MORE_ENTRIES_KEY]: `[${String(more)} more entries]` } : record;

/**
 * Returns the redacted result of `value.toJSON()`, boxed so an `undefined` result still counts.
 * Returns `undefined` when there is no `toJSON` or it returns `value` itself.
 */
const redactToJson = (
  walk: RedactWalk,
  value: WalkedObject,
  depth: number,
): { readonly value: RedactedLogValue } | undefined => {
  const toJson = value.toJSON;
  if (typeof toJson !== 'function') {
    return undefined;
  }

  let json: unknown;
  try {
    json = toJson.call(value);
  } catch {
    return { value: UNSERIALIZABLE_LOG_VALUE };
  }

  if (json === value) {
    return undefined;
  }

  return { value: redactWalkValue(walk, json, depth + 1) };
};

/**
 * Builds a plain object from `entries`, judging each value by its key (see
 * {@link redactWalkEntry}). Keys are written as they are, as own data properties, so a `__proto__`
 * key stays data. When the walk's budget runs out, the remaining entries are left out and a
 * `[more]: '[Truncated]'` entry marks the cut.
 */
export const redactWalkEntries = (
  walk: RedactWalk,
  entries: ReadonlyArray<readonly [string, unknown]>,
  depth: number,
): RedactedLogRecord => {
  const record: Record<string, RedactedLogValue> = {};
  for (const [key, item] of entries) {
    if (walk.remainingNodes <= 0) {
      writeEntry(record, MORE_ENTRIES_KEY, TRUNCATED_LOG_VALUE);
      return record;
    }

    writeEntry(record, key, redactWalkEntry(walk, key, item, depth));
  }

  return record;
};

/**
 * Writes `value` under `key` as an own data property, so a `__proto__` key stays data.
 */
const writeEntry = (
  record: Record<string, RedactedLogValue>,
  key: string,
  value: RedactedLogValue,
): void => {
  if (key === PROTO_KEY) {
    Object.defineProperty(record, key, {
      value,
      enumerable: true,
      writable: true,
      configurable: true,
    });
  } else {
    record[key] = value;
  }
};

/**
 * Redacts one property value: written as {@link REDACTED_LOG_VALUE} when the rules mask it under
 * `key` (see `CredentialRules.masksEntry`), otherwise redacted by its own content. A masked value
 * counts against the walk's budget like a copied one, so a graph of shared records full of
 * sensitive keys is bounded too.
 */
export const redactWalkEntry = (
  walk: RedactWalk,
  key: string,
  item: unknown,
  depth: number,
): RedactedLogValue => {
  if (walk.rules.masksEntry(key, item)) {
    walk.remainingNodes -= 1;
    return walk.remainingNodes < 0 ? TRUNCATED_LOG_VALUE : REDACTED_LOG_VALUE;
  }

  return redactWalkValue(walk, item, depth + 1);
};
