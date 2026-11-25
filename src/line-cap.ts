import { Formatter } from 'effect';

import type { ErrorSummary, StructuredLogRecord } from './types.ts';

import { omitUndefined } from './omit-undefined.ts';

/**
 * Default cap for one JSON log line, newline included: 16 KiB, which stays well below the line
 * limits of container log drivers.
 */
export const DEFAULT_MAX_LINE_BYTES = 16 * 1024;

/**
 * What a shortened `cause` or `message` ends with, so a reader can tell the text was cut.
 */
const TRUNCATION_MARKER = ' …[truncated]';

/**
 * Fields shortened, in this order, when a JSON line is over the cap. The cause goes first because
 * stack traces are what makes lines long, and the error summary's message goes before the log
 * message because large upstream error bodies end up there.
 */
const TRUNCATABLE_FIELDS = ['cause', 'error.message', 'message'] as const;

/**
 * A string field of the record that the JSON logger may shorten. `error.message` is the message of
 * the error summary.
 */
type TruncatableField = (typeof TRUNCATABLE_FIELDS)[number];

/**
 * Bytes reserved in a minimal record for everything except the message: identity, trace ids and the
 * `truncated` flag.
 */
const MINIMAL_RECORD_OVERHEAD_BYTES = 256;

/**
 * The most bytes one UTF-16 code unit of a JSON string can take: a `\uXXXX` escape.
 */
const MAX_JSON_BYTES_PER_UNIT = 6;

/**
 * Lowest UTF-16 high surrogate code unit.
 */
const HIGH_SURROGATE_MIN = 0xd8_00;

/**
 * Highest UTF-16 high surrogate code unit.
 */
const HIGH_SURROGATE_MAX = 0xdb_ff;

/**
 * Minimal record fields dropped, in this order, when a very small `maxLineBytes` still cannot hold
 * the minimal record. Trace ids go last because they link the line to its trace.
 */
const MINIMAL_DROP_ORDER = ['version', 'env', 'service', 'spanId', 'traceId'] as const;

/**
 * Error summary fields a minimal record keeps, so the kind of failure survives a cut line.
 */
type MinimalErrorSummary = Pick<ErrorSummary, 'kind' | 'tag' | 'name' | 'status'>;

/**
 * The line written when shortening fields was not enough to meet the cap. Keys are written in
 * declaration order. The identity and trace fields are copied when the original record has them,
 * and are mutable because {@link dropUntilFits} deletes them in {@link MINIMAL_DROP_ORDER} under a
 * very small cap.
 */
interface MinimalLogRecord {
  /**
   * Copied from the original record. Never dropped.
   */
  readonly timestamp: string;

  /**
   * Copied from the original record. Never dropped.
   */
  readonly level: string;

  /**
   * Process name, dropped third.
   */
  service?: string;

  /**
   * Deployment environment, dropped second.
   */
  env?: string;

  /**
   * Build version, dropped first.
   */
  version?: string;

  /**
   * Trace id, dropped last because it links the line to its trace.
   */
  traceId?: string;

  /**
   * Span id, dropped after the identity fields.
   */
  spanId?: string;

  /**
   * Start of the message, ending with the truncation marker when it was cut. A non-string message
   * is JSON-encoded first. Absent only in the last-resort record.
   */
  readonly message?: string;

  /**
   * Always true: a minimal record is by definition a shortened line.
   */
  readonly truncated: true;

  /**
   * Identity of the record's error, without its message. Left out when it would push the line over
   * the cap.
   */
  readonly error?: MinimalErrorSummary;
}

/**
 * Shared encoder that measures UTF-8 size without relying on `Buffer`.
 */
const textEncoder = new TextEncoder();

/**
 * Returns `maxLineBytes` when it is a finite positive number, otherwise `DEFAULT_MAX_LINE_BYTES`,
 * so a `Number(process.env.X)` that came out `NaN` does not reduce every line to its timestamp.
 */
export const resolveMaxLineBytes = (maxLineBytes: number | undefined): number =>
  maxLineBytes !== undefined && Number.isFinite(maxLineBytes) && maxLineBytes > 0
    ? maxLineBytes
    : DEFAULT_MAX_LINE_BYTES;

/**
 * Serializes a record built by the structured logger. Its values are already redacted plain data
 * (strings, numbers, booleans, dates, `Redacted` values, arrays and plain records, with no cycles
 * or getters), for which `JSON.stringify` writes the same text as `Formatter.formatJson` at a
 * fraction of the cost. A value `JSON.stringify` rejects, such as a `bigint`, falls back to
 * `Formatter.formatJson`.
 */
const serializeRecord = (record: StructuredLogRecord | MinimalLogRecord): string => {
  try {
    return JSON.stringify(record);
  } catch {
    return Formatter.formatJson(record);
  }
};

/**
 * Serializes `record` as one JSON line of at most `maxBytes` bytes including its newline. A line
 * over the cap costs at most two more serializations (the record with its truncatable fields
 * reduced to the marker, and the result): how much of each field fits is computed from the fields'
 * encoded sizes instead of serializing candidate lines.
 */
export const fitRecord = (record: StructuredLogRecord, maxBytes: number): string => {
  const line = serializeRecord(record);
  if (lineFits(line, maxBytes)) {
    return line;
  }

  return shortenRecord(record, line, maxBytes);
};

/**
 * Builds the line for a `record` whose full `line` is over the cap: `truncated: true` is added, and
 * `cause`, `error.message` and `message` are tried in that order. The first one that can be cut to
 * a start that fits, while the fields after it stay whole and the ones before it are reduced to the
 * truncation marker (one already shorter than the marker is kept), is cut to the longest such
 * start. When none can, the minimal record is written instead. Only the record with each field at
 * its smallest is serialized to measure it; every other candidate is measured from the fields'
 * encoded sizes.
 */
const shortenRecord = (record: StructuredLogRecord, line: string, maxBytes: number): string => {
  const fields = TRUNCATABLE_FIELDS.filter((field) => readField(record, field) !== undefined);
  const values = fields.map((field) => readField(record, field) ?? '');
  if (!mayFit(line, record, values, maxBytes)) {
    return serializeRecord(minimalRecord(record, maxBytes));
  }

  const marked: StructuredLogRecord = { ...record, truncated: true };
  const sizes = values.map((value) => jsonSize(value, maxBytes));
  const smallest = fields.reduce(
    (current, field, index) =>
      (sizes[index] ?? 0) <= MARKER_JSON_BYTES
        ? current
        : writeField(current, field, TRUNCATION_MARKER),
    marked,
  );
  const smallestBytes = lineBytes(serializeRecord(smallest), maxBytes);
  if (smallestBytes === undefined) {
    return serializeRecord(minimalRecord(record, maxBytes));
  }

  const extras = sizes.map((size) => Math.max(0, size - MARKER_JSON_BYTES));
  let fitted = marked;
  for (const [index, field] of fields.entries()) {
    const later = extras.slice(index + 1).reduce((total, extra) => total + extra, 0);
    const room = maxBytes - 1 - smallestBytes - later;
    const extra = extras[index] ?? 0;
    if (extra <= room) {
      return serializeRecord(fitted);
    }

    if (room >= 0) {
      const start = fittingStart(values[index] ?? '', room);
      return serializeRecord(writeField(fitted, field, start + TRUNCATION_MARKER));
    }

    if (extra > 0) {
      fitted = writeField(fitted, field, TRUNCATION_MARKER);
    }
  }

  return serializeRecord(minimalRecord(record, maxBytes));
};

/**
 * Bytes of `text` as JSON string content, quotes excluded, or infinity when that is over `limit`,
 * so a huge field is measured only as far as the cap.
 */
const jsonSize = (text: string, limit: number): number => {
  const prefix = jsonPrefix(text, limit);
  return prefix.units === text.length ? prefix.bytes : Number.POSITIVE_INFINITY;
};

/**
 * Tells whether the line of `record` could fit in `maxBytes` once `truncated: true` is added and
 * each truncatable field (`values`) is at its smallest (whole, or the marker when that is shorter),
 * judged from the full `line` without serializing again: every UTF-16 unit of a JSON line takes at
 * least one byte. `false` means no shortened line can fit.
 */
const mayFit = (
  line: string,
  record: StructuredLogRecord,
  values: ReadonlyArray<string>,
  maxBytes: number,
): boolean => {
  let units = line.length + ('truncated' in record ? 0 : TRUNCATED_FLAG_UNITS);
  for (const value of values) {
    const encoded = JSON.stringify(value).length;
    units -= encoded - Math.min(encoded, MARKER_JSON_UNITS);
  }

  return units + 1 <= maxBytes;
};

/**
 * Units `,"truncated":true` adds to a record that did not have the flag.
 */
const TRUNCATED_FLAG_UNITS = ',"truncated":true'.length;

/**
 * Units of the truncation marker as a JSON string, quotes included.
 */
const MARKER_JSON_UNITS = JSON.stringify(TRUNCATION_MARKER).length;

/**
 * Character code of `"`.
 */
const QUOTE_CODE = 0x22;

/**
 * Character code of a backslash.
 */
const BACKSLASH_CODE = 0x5c;

/**
 * Control characters `JSON.stringify` writes as a two-character escape: backspace, tab, line feed,
 * form feed and carriage return.
 */
const SHORT_ESCAPE_CODES: ReadonlySet<number> = new Set([0x08, 0x09, 0x0a, 0x0c, 0x0d]);

/**
 * Lowest UTF-16 low surrogate code unit.
 */
const LOW_SURROGATE_MIN = 0xdc_00;

/**
 * Highest UTF-16 low surrogate code unit.
 */
const LOW_SURROGATE_MAX = 0xdf_ff;

/**
 * Tells whether `code` is a UTF-16 low surrogate. `NaN` (read past the end of a string) is not.
 */
const isLowSurrogate = (code: number): boolean =>
  code >= LOW_SURROGATE_MIN && code <= LOW_SURROGATE_MAX;

/**
 * Bytes `JSON.stringify` writes, in UTF-8, for one UTF-16 unit that is not half of a surrogate
 * pair: two for a quote, a backslash and the short control escapes, six for other control
 * characters and lone surrogates (`\u` escapes), and the character's UTF-8 size otherwise.
 */
const jsonUnitBytes = (code: number): number => {
  if (code === QUOTE_CODE || code === BACKSLASH_CODE) {
    return 2;
  }

  if (code < 0x20) {
    return SHORT_ESCAPE_CODES.has(code) ? 2 : MAX_JSON_BYTES_PER_UNIT;
  }

  if (code < 0x80) {
    return 1;
  }

  if (code < 0x8_00) {
    return 2;
  }

  return code >= HIGH_SURROGATE_MIN && code <= LOW_SURROGATE_MAX ? MAX_JSON_BYTES_PER_UNIT : 3;
};

/**
 * A start of a string, as {@link jsonPrefix} measures it.
 */
interface JsonPrefix {
  /**
   * Length of the start in UTF-16 units.
   */
  readonly units: number;

  /**
   * Size of the start as JSON string content in UTF-8, quotes excluded.
   */
  readonly bytes: number;
}

/**
 * The longest start of `text` whose JSON-escaped UTF-8 form, quotes excluded, takes at most
 * `budget` bytes: its length in UTF-16 units and its size in bytes. A surrogate pair is kept or
 * dropped whole. Reads at most one unit past the start it returns, so a long `text` against a small
 * budget costs little.
 */
const jsonPrefix = (text: string, budget: number): JsonPrefix => {
  let bytes = 0;
  let index = 0;
  while (index < text.length) {
    const code = text.charCodeAt(index);
    const paired =
      code >= HIGH_SURROGATE_MIN &&
      code <= HIGH_SURROGATE_MAX &&
      isLowSurrogate(text.charCodeAt(index + 1));
    const size = paired ? 4 : jsonUnitBytes(code);
    if (bytes + size > budget) {
      break;
    }

    bytes += size;
    index += paired ? 2 : 1;
  }

  return { units: index, bytes };
};

/**
 * The longest {@link cutText} start of `text` whose JSON-escaped UTF-8 form takes at most `budget`
 * bytes. A lone high surrogate at the end of the start that fits is dropped, as `cutText` drops it,
 * unless the unit after the start is itself a high surrogate.
 */
const fittingStart = (text: string, budget: number): string => {
  const { units } = jsonPrefix(text, budget);
  const next = text.charCodeAt(units);
  return next >= HIGH_SURROGATE_MIN && next <= HIGH_SURROGATE_MAX
    ? text.slice(0, units)
    : cutText(text, units);
};

/**
 * Bytes of the truncation marker as JSON string content, quotes excluded.
 */
const MARKER_JSON_BYTES = jsonPrefix(TRUNCATION_MARKER, Number.POSITIVE_INFINITY).bytes;

/**
 * Scratch buffer {@link lineBytes} encodes into, grown to the largest line it has measured, so
 * measuring a line allocates no copy of it.
 */
let encodeScratch = new Uint8Array(0);

/**
 * UTF-8 size of `line` when it and its newline fit in `maxBytes`, otherwise `undefined`. A line
 * with more UTF-16 units than the cap is rejected without encoding (each unit takes at least one
 * byte); any other is encoded into a reused buffer no larger than the cap or three bytes per unit.
 */
const lineBytes = (line: string, maxBytes: number): number | undefined => {
  if (line.length + 1 > maxBytes) {
    return undefined;
  }

  const size = Math.min(Math.floor(maxBytes), line.length * MAX_UTF8_BYTES_PER_UNIT);
  if (encodeScratch.length < size) {
    encodeScratch = new Uint8Array(size);
  }

  const { read, written } = textEncoder.encodeInto(line, encodeScratch.subarray(0, size));
  return read === line.length && written + 1 <= maxBytes ? written : undefined;
};

/**
 * The most UTF-8 bytes one UTF-16 unit of a well-formed string takes.
 */
const MAX_UTF8_BYTES_PER_UNIT = 3;

/**
 * Tells whether `line` and its newline fit in `maxBytes` UTF-8 bytes. A line short enough to fit at
 * three bytes per UTF-16 unit is not measured.
 */
const lineFits = (line: string, maxBytes: number): boolean =>
  line.length * MAX_UTF8_BYTES_PER_UNIT + 1 <= maxBytes || lineBytes(line, maxBytes) !== undefined;

/**
 * Reads `field`, or `undefined` when it is absent or, for the log message, not a string.
 */
const readField = (record: StructuredLogRecord, field: TruncatableField): string | undefined => {
  switch (field) {
    case 'cause':
      return record.cause;
    case 'error.message':
      return record.error?.message;
    case 'message':
      return typeof record.message === 'string' ? record.message : undefined;
    default: {
      const unexpected: never = field;
      return unexpected;
    }
  }
};

/**
 * Returns a copy of `record` with `text` in `field`, copying the error summary when it changes. The
 * field keeps its position in the record. A record without an error summary is returned unchanged
 * for `error.message`.
 */
const writeField = (
  record: StructuredLogRecord,
  field: TruncatableField,
  text: string,
): StructuredLogRecord => {
  switch (field) {
    case 'cause':
      return { ...record, cause: text };
    case 'error.message':
      return record.error === undefined
        ? record
        : { ...record, error: { ...record.error, message: text } };
    case 'message':
      return { ...record, message: text };
    default: {
      const unexpected: never = field;
      return unexpected;
    }
  }
};

/**
 * Keeps the first `keep` UTF-16 units of `text`, dropping one more when the cut would leave a lone
 * high surrogate.
 */
const cutText = (text: string, keep: number): string => {
  let end = Math.min(keep, text.length);
  const last = end > 0 ? text.charCodeAt(end - 1) : 0;
  if (last >= HIGH_SURROGATE_MIN && last <= HIGH_SURROGATE_MAX) {
    end -= 1;
  }

  return text.slice(0, end);
};

/**
 * Builds the smallest record that still says what happened: time, level, identity, trace ids, the
 * kind of error and as much of the message as is certain to fit. The error identity is dropped when
 * it would push the line over the cap. Under a very small cap the identity and trace fields are
 * dropped one at a time ({@link MINIMAL_DROP_ORDER}), and the last resort is `timestamp`, `level`
 * and `truncated` alone.
 */
const minimalRecord = (record: StructuredLogRecord, maxBytes: number): MinimalLogRecord => {
  const message =
    typeof record.message === 'string' ? record.message : Formatter.formatJson(record.message);
  const units = Math.max(
    0,
    Math.floor((maxBytes - MINIMAL_RECORD_OVERHEAD_BYTES) / MAX_JSON_BYTES_PER_UNIT),
  );
  const minimal: MinimalLogRecord = {
    timestamp: record.timestamp,
    level: record.level,
    ...omitUndefined({
      service: record.service,
      env: record.env,
      version: record.version,
      traceId: record.traceId,
      spanId: record.spanId,
    }),
    message: message.length > units ? cutText(message, units) + TRUNCATION_MARKER : message,
    truncated: true,
  };
  const error = minimalError(record);
  if (error !== undefined) {
    const withError = { ...minimal, error };
    if (lineFits(serializeRecord(withError), maxBytes)) {
      return withError;
    }
  }

  return dropUntilFits(minimal, maxBytes);
};

/**
 * Drops the fields of {@link MINIMAL_DROP_ORDER} from `minimal` one at a time until its line fits,
 * falling back to `timestamp`, `level` and `truncated` alone.
 */
const dropUntilFits = (minimal: MinimalLogRecord, maxBytes: number): MinimalLogRecord => {
  const candidate = { ...minimal };
  if (lineFits(serializeRecord(candidate), maxBytes)) {
    return candidate;
  }

  for (const key of MINIMAL_DROP_ORDER) {
    if (key in candidate) {
      delete candidate[key];
      if (lineFits(serializeRecord(candidate), maxBytes)) {
        return candidate;
      }
    }
  }

  return { timestamp: minimal.timestamp, level: minimal.level, truncated: true };
};

/**
 * Keeps the identity fields of the record's error summary, without its message.
 */
const minimalError = (record: StructuredLogRecord): MinimalErrorSummary | undefined => {
  if (record.error === undefined) {
    return undefined;
  }

  const { kind, tag, name, status } = record.error;
  return { kind, ...omitUndefined({ tag, name, status }) };
};
