/**
 * Text written in place of a secret. It matches what Effect prints for a `Redacted` value, so a
 * masked key and a `Redacted` field look the same in every format.
 */
export const REDACTED_LOG_VALUE = '<redacted>';

/**
 * Options for the redaction rules. Each list adds to the built-in one, never replacing it.
 *
 * A string entry matches a whole key whose letters and digits are the same, ignoring case and the
 * separators `-`, `_`, `.` and spaces, so `'tokenType'` also matches `token_type` and `TOKEN-TYPE`
 * but not `refreshTokenType`.
 */
export interface RedactionOptions {
  /**
   * Keys whose values are always masked, numbers and booleans included, on top of the built-in
   * list. A `RegExp` entry is tested against the key as written (its `g` and `y` flags are
   * ignored). A key matched here is masked even when it is also in {@link allowKeys}.
   */
  readonly sensitiveKeys?: ReadonlyArray<string | RegExp> | undefined;

  /**
   * Keys that match a built-in sensitive name but hold no secret (`tokenType`, `expiresIn`). A
   * value under one is redacted by its own content like a value under any other key.
   */
  readonly allowKeys?: ReadonlyArray<string> | undefined;

  /**
   * Runs on every text the built-in shapes run on (string values, messages, span names and labels,
   * error summaries, rendered causes), after them. It must return the text to write. When it
   * throws, the text is written as {@link REDACTED_LOG_VALUE}.
   */
  readonly scrubText?: ((text: string) => string) | undefined;
}

/**
 * The rules every redaction of one {@link RedactionOptions} applies, so log fields, messages, causes
 * and span data agree.
 */
export interface CredentialRules {
  /**
   * Tells whether `value`, found under `key`, is written as {@link REDACTED_LOG_VALUE}: under a
   * configured sensitive key anything but `null` and `undefined`, and under a built-in sensitive
   * key (not allowed) anything but those, a `number` and a `boolean`.
   */
  readonly masksEntry: (key: string, value: unknown) => boolean;

  /**
   * Tells whether `key` is a sensitive name, built-in or configured, and not allowed.
   */
  readonly isSensitiveKey: (key: string) => boolean;

  /**
   * Tells whether a URL query or fragment parameter called `name` carries a credential: its
   * percent-decoded name, in any case, is one of the query credential names (`key`, `apikey`,
   * `auth`, `code`, `sig`, `signature`, `token`, `x-amz-signature`, `x-amz-credential`,
   * `x-amz-security-token`, `x-goog-signature`), or {@link isSensitiveKey} accepts it.
   */
  readonly isSensitiveQueryParamName: (name: string) => boolean;

  /**
   * Masks the convenience shapes in `text` (see {@link redactLogString}), then runs the configured
   * `scrubText`. Never throws.
   */
  readonly redactText: (text: string) => string;
}

/**
 * Built-in sensitive names, tested on the normalized key (lowercase, separators removed), so every
 * casing and separator style matches (`client_secret`, `clientSecret`, `X-Api-Key`, `set-cookie`).
 */
const SENSITIVE_KEY_PATTERN =
  /passw(?:or)?d|passphrase|pwd|secret|token|authori[sz]ation|cookie|(?:api|access|private|auth|client|signing|encryption|master)key|session|signature|credential|bearer|jwt/;

/**
 * Query parameter names that carry a credential in a URL although they are ordinary words
 * elsewhere: API keys, URL signatures (AWS and Google signed URLs among them), OAuth's
 * authorization `code` and `auth`. Lower case; compared with the decoded name in lower case.
 */
const QUERY_CREDENTIAL_NAMES: ReadonlySet<string> = new Set([
  'key',
  'apikey',
  'auth',
  'code',
  'sig',
  'signature',
  'token',
  'x-amz-signature',
  'x-amz-credential',
  'x-amz-security-token',
  'x-goog-signature',
]);

/**
 * Text that may hold one of the convenience shapes: a `=` (query values), a `://` (userinfo) or an
 * auth scheme word. Other text is returned without running any of them.
 */
const MAYBE_SHAPE_PATTERN = /=|:\/\/|b(?:earer|asic)/i;

/**
 * Characters ignored when keys are compared.
 */
const KEY_SEPARATOR_PATTERN = /[-_.\s]/g;

/**
 * Most key verdicts remembered per set of rules. The cache is emptied when it is full, so a stream
 * of distinct keys cannot grow it without bound.
 */
const MAX_CACHED_KEYS = 4096;

/**
 * Longest key whose verdict is remembered.
 */
const MAX_CACHED_KEY_LENGTH = 128;

/**
 * An `Authorization`-style credential: the scheme word, whitespace and an optional quote (group 1,
 * kept), then the token up to the next space, quote, comma or semicolon.
 */
const AUTH_SCHEME_PATTERN = /\b((?:Bearer|Basic)\s+["']?)[^\s"',;]+/gi;

/**
 * The name of a URL query, matrix or fragment parameter (group 1), after its separator and up to
 * its `=`. The name is bounded and the value is not consumed, so a parameter nested in another
 * one's value (`?next=https://h/cb?token=x`) is found too, and the scan stays linear.
 */
const QUERY_NAME_PATTERN = /[?&;#]([\w.%+[\]-]{1,128})=/g;

/**
 * A query parameter value: everything up to `&`, `#` or whitespace, so `?token=a;b` and
 * `?password=ab?cd` are hidden whole.
 */
const QUERY_VALUE_PATTERN = /[^&#\s]*/y;

/**
 * Characters of a URL scheme after its first letter.
 */
const SCHEME_CHAR_PATTERN = /[a-z0-9+.-]/i;

/**
 * An ASCII letter, which a URL scheme must start with.
 */
const SCHEME_START_PATTERN = /[a-z]/i;

/**
 * The run after `://` that may hold userinfo: everything up to whitespace or `/`.
 */
const USERINFO_RUN_PATTERN = /[^\s/]*/y;

/**
 * Percent-decodes a query parameter name (`+` as a space), keeping it as written when it is not
 * valid percent-encoding.
 */
const decodeParamName = (name: string): string => {
  if (!name.includes('%') && !name.includes('+')) {
    return name;
  }

  try {
    return decodeURIComponent(name.replaceAll('+', ' '));
  } catch {
    return name;
  }
};

/**
 * How a key is judged before its value is seen: `configured` always masks, `builtin` masks all but
 * numbers and booleans, `plain` never masks.
 */
type KeyClass = 'configured' | 'builtin' | 'plain';

/**
 * Lowercases `key` and drops its separators, so `token_type` and `tokenType` compare equal.
 */
const normalizeKey = (key: string): string =>
  key.replaceAll(KEY_SEPARATOR_PATTERN, '').toLowerCase();

/**
 * Turns `sensitiveKeys` entries into one predicate: strings compared normalized and whole, regexes
 * tested on the key as written.
 */
const keyMatcher = (
  entries: ReadonlyArray<string | RegExp> | undefined,
): ((key: string, normalized: string) => boolean) => {
  if (entries === undefined || entries.length === 0) {
    return () => false;
  }

  const names = new Set<string>();
  const patterns: Array<RegExp> = [];
  for (const entry of entries) {
    if (typeof entry === 'string') {
      names.add(normalizeKey(entry));
    } else {
      patterns.push(new RegExp(entry.source, entry.flags.replaceAll(/[gy]/g, '')));
    }
  }

  return (key, normalized) =>
    names.has(normalized) || patterns.some((pattern) => pattern.test(key));
};

/**
 * Masks the userinfo of every URL in `text`: from the `://` of a scheme that starts with a letter
 * to the last `@` before the next whitespace or `/`, so a password holding a raw `@`, `?` or `#` is
 * hidden whole. It jumps from one `://` to the next and looks for each `@` once, so its time is
 * linear in `text`.
 */
const maskUserinfo = (text: string): string => {
  let output = '';
  let cursor = 0;
  let nextAt = -1;
  let separator = text.indexOf('://');
  while (separator !== -1) {
    let schemeStart = separator;
    while (schemeStart > 0 && SCHEME_CHAR_PATTERN.test(text.charAt(schemeStart - 1))) {
      schemeStart -= 1;
    }

    const start = separator + '://'.length;
    if (nextAt < start) {
      const following = text.indexOf('@', start);
      nextAt = following === -1 ? text.length : following;
    }

    USERINFO_RUN_PATTERN.lastIndex = start;
    const runEnd = start + (USERINFO_RUN_PATTERN.exec(text)?.[0].length ?? 0);
    const at = nextAt < runEnd ? text.lastIndexOf('@', runEnd - 1) : -1;
    const isScheme = schemeStart < separator && SCHEME_START_PATTERN.test(text.charAt(schemeStart));
    if (isScheme && at > start) {
      output += text.slice(cursor, start) + REDACTED_LOG_VALUE;
      cursor = at;
      separator = text.indexOf('://', at + 1);
    } else {
      separator = text.indexOf('://', separator + 1);
    }
  }

  return cursor === 0 ? text : output + text.slice(cursor);
};

/**
 * Builds the {@link CredentialRules} for `options`. Key verdicts are cached, since the same field
 * names come back on every line.
 */
export const makeCredentialRules = (options: RedactionOptions = {}): CredentialRules => {
  const configured = keyMatcher(options.sensitiveKeys);
  const allowed = new Set(options.allowKeys?.map(normalizeKey));
  const scrub = options.scrubText;
  const cache = new Map<string, KeyClass>();

  /**
   * Classifies `key` without the cache.
   */
  const computeClass = (key: string): KeyClass => {
    const normalized = normalizeKey(key);
    if (configured(key, normalized)) {
      return 'configured';
    }

    return SENSITIVE_KEY_PATTERN.test(normalized) && !allowed.has(normalized) ? 'builtin' : 'plain';
  };

  /**
   * Classifies `key`, remembering the verdict for keys up to {@link MAX_CACHED_KEY_LENGTH}.
   */
  const keyClass = (key: string): KeyClass => {
    const cached = cache.get(key);
    if (cached !== undefined) {
      return cached;
    }

    const computed = computeClass(key);
    if (key.length <= MAX_CACHED_KEY_LENGTH) {
      if (cache.size >= MAX_CACHED_KEYS) {
        cache.clear();
      }

      cache.set(key, computed);
    }

    return computed;
  };

  /**
   * See {@link CredentialRules.isSensitiveKey}.
   */
  const isSensitiveKey = (key: string): boolean => keyClass(key) !== 'plain';

  /**
   * See {@link CredentialRules.masksEntry}.
   */
  const masksEntry = (key: string, value: unknown): boolean => {
    if (value === null || value === undefined) {
      return false;
    }

    const verdict = keyClass(key);
    if (verdict !== 'builtin') {
      return verdict === 'configured';
    }

    return typeof value !== 'number' && typeof value !== 'boolean';
  };

  /**
   * See {@link CredentialRules.isSensitiveQueryParamName}.
   */
  const isSensitiveQueryParamName = (name: string): boolean => {
    const decoded = decodeParamName(name);
    return QUERY_CREDENTIAL_NAMES.has(decoded.toLowerCase()) || isSensitiveKey(decoded);
  };

  /**
   * Masks the convenience shapes: sensitive query values first (so a value holding `@` is not read
   * as userinfo), then URL userinfo, then auth schemes. Text without a `=`, `://` or auth scheme
   * word is returned at once.
   */
  const maskShapes = (text: string): string => {
    if (!MAYBE_SHAPE_PATTERN.test(text)) {
      return text;
    }

    const withoutQueryValues = text.includes('=') ? maskQueryValues(text) : text;
    const withoutUserinfo = withoutQueryValues.includes('://')
      ? maskUserinfo(withoutQueryValues)
      : withoutQueryValues;
    return withoutUserinfo.replaceAll(
      AUTH_SCHEME_PATTERN,
      (_, scheme: string) => `${scheme}${REDACTED_LOG_VALUE}`,
    );
  };

  /**
   * Masks the value of every query, matrix or fragment parameter whose name
   * {@link isSensitiveQueryParamName} accepts. A masked value is skipped as a whole. It drives the
   * shared {@link QUERY_NAME_PATTERN} from index 0; nothing it calls in the loop uses that regex.
   */
  const maskQueryValues = (text: string): string => {
    let output = '';
    let cursor = 0;
    const names = QUERY_NAME_PATTERN;
    names.lastIndex = 0;
    for (let match = names.exec(text); match !== null; match = names.exec(text)) {
      if (!isSensitiveQueryParamName(match[1] ?? '')) {
        continue;
      }

      const start = match.index + match[0].length;
      QUERY_VALUE_PATTERN.lastIndex = start;
      const end = start + (QUERY_VALUE_PATTERN.exec(text)?.[0].length ?? 0);
      if (end > start) {
        output += text.slice(cursor, start) + REDACTED_LOG_VALUE;
        cursor = end;
        names.lastIndex = end;
      }
    }

    return cursor === 0 ? text : output + text.slice(cursor);
  };

  /**
   * See {@link CredentialRules.redactText}.
   */
  const redactText = (text: string): string => {
    const masked = maskShapes(text);
    if (scrub === undefined) {
      return masked;
    }

    try {
      return scrub(masked);
    } catch {
      return REDACTED_LOG_VALUE;
    }
  };
  return { masksEntry, isSensitiveKey, isSensitiveQueryParamName, redactText };
};

/**
 * The rules with only the built-in list, behind every function of this package that takes no
 * {@link RedactionOptions}.
 */
export const defaultCredentialRules: CredentialRules = makeCredentialRules();

/**
 * Tells whether `key` contains a built-in sensitive name, in any case or separator style
 * (`client_secret`, `clientSecret`, `X-Api-Key`, `set-cookie`, `sessionId`, `tokenCount`). A value
 * under such a key is masked unless it is a `number`, a `boolean`, `null` or `undefined`.
 */
export const isSensitiveLogKey = (key: string): boolean =>
  defaultCredentialRules.isSensitiveKey(key);

/**
 * Tells whether the value of a URL query or fragment parameter called `name` is a credential, using
 * the built-in names: its percent-decoded name, in any case, is `key`, `apikey`, `auth`, `code`,
 * `sig`, `signature`, `token`, `x-amz-signature`, `x-amz-credential`, `x-amz-security-token` or
 * `x-goog-signature`, or {@link isSensitiveLogKey} accepts it (`access_token`, `client_secret`,
 * `creds[token]`). {@link redactLogString} masks query values by this rule.
 */
export const isSensitiveQueryParamName = (name: string): boolean =>
  defaultCredentialRules.isSensitiveQueryParamName(name);

/**
 * Masks a fixed list of credential shapes in `text`, and nothing else:
 *
 * - URL userinfo becomes `scheme://<redacted>@`;
 * - `Bearer <token>` and `Basic <credentials>` keep the scheme word;
 * - URL query, matrix and fragment values (after `?`, `&`, `;` or `#`) under a name
 *   {@link isSensitiveQueryParamName} accepts.
 *
 * Every other way of writing a secret into text is written as it is. The cost is linear in the
 * length of `text`, and running it twice gives the same result as running it once.
 */
export const redactLogString = (text: string): string => defaultCredentialRules.redactText(text);
