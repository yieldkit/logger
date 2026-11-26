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

- **`Redacted` and `Redactable` values** are hidden wherever they appear, Effect `Headers` included (they honour `Headers.CurrentRedactedNames`). A `Redactable` value is replaced by its redacted form. An object that only carries the `Redacted` marker key (parsed JSON, say) becomes `<redacted>`.
- **Values under a sensitive key name** are masked whole, whatever they hold: an object, array, `Map` or `Set` under such a key becomes one `<redacted>`. Keys are compared in lowercase with `-`, `_`, `.` and spaces removed, and a key matches when it contains one of the built-in names:

  `password`, `passwd`, `passphrase`, `pwd`, `secret`, `token`, `authorization`, `cookie`, `apiKey`, `accessKey`, `privateKey`, `authKey`, `clientKey`, `signingKey`, `encryptionKey`, `masterKey`, `session`, `signature`, `credential`, `bearer`, `jwt`.

  Under a built-in name, a `number` or `boolean` is kept (`tokenCount: 1200`, `sessionActive: true`); every other value is masked, strings, `bigint` and `Date` included. `null` and `undefined` are never masked. Names that only end in `key` (`cacheKey`, `publicKey`) are not sensitive.

- **Your own names.** `sensitiveKeys` adds names; a value under one is always masked, numbers and booleans included. `allowKeys` exempts names from the built-in list (`tokenType`, `expiresIn`): a value under an allowed key is redacted by its own content like any other. A key in both lists is masked. See [Your own keys](#your-own-keys).
- **Causes.** Each fail and die value is replaced by its redacted form when it is `Redactable`, a value that is not an `Error` is redacted like a field, and an `Error`'s `cause` chain is treated the same way, so `new Error('x', { cause: { password } })` renders `password` masked.
- **The walk never throws.** Cycles become `[Circular]`, nesting past 8 levels `[Truncated]`, unreadable values `[Unserializable]`, binary data `[Uint8Array 4096 bytes]`. Collections keep their first 1,000 items.

`redactLogValue` returns a deep copy and never mutates its input. An `Error` becomes `{ name, message, …, cause }` without its stack, a `Map` an object, a `Set` an array and a function `[Function]`.

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

A string entry matches a whole key in any case or separator style (`'tokenType'` matches `token_type`, not `refreshTokenType`). A `RegExp` is tested against the key as written. Every layer, logger builder and test helper takes `redaction`; the crash handlers use the logger layer's. Logs and spans are redacted separately, so pass the same value to both.

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

```ts
const redaction = makeLogRedaction({ sensitiveKeys: ['customerRef'] });
redaction.redactValue({ customerRef: 'c-1' }); // { customerRef: '<redacted>' }
```
