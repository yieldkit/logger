# Durations and request ids

## Durations

`durationHistogram(name, description)` builds an Effect histogram in milliseconds with `durationMsBoundaries`: 15 bounds that start at 5 ms and double up to 81,920 ms, then `Infinity`. `recordDurationMs(histogram)` times an effect into it:

```ts
import { durationHistogram, recordDurationMs } from '@yieldkit/logger';

const queryMs = durationHistogram('db_query_ms', 'Time spent in one query');
const timed = runQuery.pipe(recordDurationMs(queryMs));
```

The time is recorded on success, failure and interruption, read from the clock's monotonic time (`monotonicTimeNanos`), so a wall-clock step (NTP, a manual change) during the effect doesn't distort it. `TestClock.adjust` advances it in tests.

## Request ids

A request id is kept when it is 1 to 128 characters of letters, digits and `_.:=-`. Anything else, including an empty string or a line break, is replaced by a fresh UUID, so an incoming header cannot inject log lines.

<!-- prettier-ignore -->
```ts
REQUEST_ID_HEADER;                     // 'x-request-id'
requestIdFromHeaders(request.headers); // Fetch Headers: the header when valid, else a new id
resolveRequestId('abc-123');           // 'abc-123'
resolveRequestId('bad\nid');           // a new UUID
isValidRequestId('abc-123');           // true
generateRequestId();                   // crypto.randomUUID()
```

`requestIdFromHeaders` takes Fetch `Headers`. With Effect `Headers`, a plain record, use `resolveRequestId(headers['x-request-id'])`.
