# Redaction

Every output is redacted: all console formats, span events, OTLP logs and spans, and test records. That covers the message, annotations, log span labels, the cause, span names, span and event attributes, and link attributes.

The logger decides what to mask from a value's **type** and its **key name**, never from the content of a string or the shape of a container. There are three tiers.

## Guaranteed

<!-- prettier-ignore -->
```ts
redactLogValue({
  password: 'hunter2',                // '<redacted>'
  tokenCount: 1200,                   // 1200: a number under a built-in name is kept
  tokens: ['tok-1'],                  // '<redacted>'
  apiKey: Redacted.make('k'),         // prints '<redacted>'
  nested: { cookie: { a: 1 } },       // { cookie: '<redacted>' }
});
```

- **`Redacted` and `Redactable` values** are hidden wherever they appear: fields, messages, errors and their `cause` chains, fail and die values of a cause, error summaries, Effect `Headers` (which honour `Headers.CurrentRedactedNames`) and span attributes. A `Redactable` value is replaced by its redacted form. An object that only carries the `Redacted` marker key (parsed JSON, say) becomes `<redacted>`.
- **Values under a sensitive key name** are masked whole, whatever they hold: an object, array, `Map` or `Set` under such a key becomes one `<redacted>`. Keys are compared in lowercase with `-`, `_`, `.` and spaces removed, and a key matches when it contains one of the built-in names:

  `password`, `passwd`, `passphrase`, `pwd`, `secret`, `token`, `authorization`, `cookie`, `apiKey`, `accessKey`, `privateKey`, `authKey`, `clientKey`, `signingKey`, `encryptionKey`, `masterKey`, `session`, `signature`, `credential`, `bearer`, `jwt`.

  Under a built-in name, a `number` or `boolean` is kept (`tokenCount: 1200`, `sessionActive: true`); every other value is masked, strings, `bigint` and `Date` included. `null` and `undefined` are never masked. Names that only end in `key` (`cacheKey`, `publicKey`) are not sensitive.

- **Your own names.** `sensitiveKeys` adds names; a value under one is always masked, numbers and booleans included. `allowKeys` exempts names from the built-in list (`tokenType`, `expiresIn`): a value under an allowed key is redacted by its own content like any other. A key in both lists is masked. See [Your own keys](#your-own-keys).
- **Causes.** Each fail and die value is replaced by its redacted form when it is `Redactable`, a value that is not an `Error` is redacted like a field, and an `Error`'s `cause` chain is treated the same way, so `new Error('x', { cause: { password } })` renders `password` masked.
- **The walk never throws and its cost is bounded.** A cycle becomes `[Circular]`, nesting deeper than 8 levels `[Truncated]`, and a value that throws when read `[Unserializable]`. Binary data (`ArrayBuffer`, typed arrays, `DataView`, `Buffer`) becomes `[Uint8Array 4096 bytes]`. An array or `Set` keeps its first 1,000 items, then `[n more items]`; a `Map` or object its first 1,000 entries, then `[more]: '[n more entries]'`. After 10,000 values in one call, masked ones included, the rest of the array becomes one `[Truncated]` item and the rest of the record one `[more]: '[Truncated]'` entry.

`redactLogValue` returns a deep copy and never modifies its input. An `Error` becomes `{ name, message, ...own properties, cause }` without its stack, a `Map` an object keyed by `String(key)`, a `Set` an array, an object with `toJSON` its redacted `toJSON()` result, and a function `[Function]`. Keys are written as they are.

## Convenience

A fixed list of shapes is masked in text, on by default and with no guarantee beyond this list:

- URL userinfo: `postgres://app:pw@db/main` becomes `postgres://<redacted>@db/main`;
- `Bearer` and `Basic` credentials: `Bearer <redacted>`;
- URL query and fragment values (after `?`, `&`, `;` or `#`) whose percent-decoded name (`+` read as a space) is a sensitive key (as judged above) or, in any case, one of `key`, `apikey`, `auth`, `code`, `sig`, `signature`, `token`, `x-amz-signature`, `x-amz-credential`, `x-amz-security-token`, `x-goog-signature`: `?page=2&sig=<redacted>`. `isSensitiveQueryParamName(name)` is that rule.

It runs on string values, messages, log span labels, span and event names, the error summary's message, tag and name, and once on each rendered fail or die of a cause (the text Effect prints, stack frames included). Interrupt reasons are kept as they are, including the span names in their trace.

The word after `Bearer` or `Basic` is masked in any letter case, so prose such as "basic auth" or "the bearer of" loses its next word.

## Opt-in

`scrubText: (text) => string` runs after the convenience list, wherever it runs. Use it for shapes of your own. If it throws, the text is written as `<redacted>`. It can run more than once on the same text, so applying it twice must give the same result as applying it once.

```ts
const redaction = { scrubText: (text: string) => text.replaceAll(/sk_live_\w+/g, '<redacted>') };
```

## Your own keys

`redaction` (a `RedactionOptions`) adds to the built-in list; it never replaces it.

```ts
const redaction = {
  sensitiveKeys: ['customerRef', /^x-internal-/i],
  allowKeys: ['tokenType', 'expiresIn'],
};

const LoggerLayer = LoggerLive({ service: 'api', redaction });
const TracingLayer = tracingLayer('api', { redaction });
```

A string entry matches a whole key with the same letters and digits in any case or separator style (`'tokenType'` matches `token_type`, not `refreshTokenType`). A `RegExp` entry in `sensitiveKeys` is tested against the key as written. It is accepted by `LoggerLive`, `makeLoggerLayer`, `telemetryLayer`, `tracingLayer`, the logger builders, `makeTestLogger`, `captureLogs`, `makeStartupFailureTeardown` and `describeStartupFailure`. The crash handlers take no `redaction`: crash lines are redacted by the logger layer they are built on. Logs and spans are redacted separately, so pass the same value to the logger and the telemetry layer.

## Functions

The module-level functions use the built-in list only:

<!-- prettier-ignore -->
```ts
isSensitiveLogKey('clientSecret'); // true
isSensitiveLogKey('tokenCount');   // true: a number under it is still kept
redactLogValue(value);             // the guaranteed tier plus the convenience list on strings
redactLogString(text);             // the convenience list
isSensitiveQueryParamName('sig');  // true: the query-name rule of the convenience list
sanitizeCause(cause);              // a cause whose rendering holds no Redactable or masked value
withRedaction(logger);             // wraps any Effect Logger
withTracerRedaction(tracer);       // wraps any Tracer: names, attributes, links, failure cause
redactedTracerLogger;              // Logger.tracerLogger, redacted
REDACTED_LOG_VALUE;                // '<redacted>'
```

With your own options, `makeLogRedaction(options)` returns the same functions as a `LogRedaction` (`redactValue`, `redactString`, `sanitizeCause`, `withRedaction`, `withTracerRedaction`). `defaultLogRedaction` is the built-in one.
