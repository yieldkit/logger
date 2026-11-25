# Callback logger

Code that runs outside a fiber, such as an event emitter listener or a library hook, cannot yield a log effect. `makeCallbackLogger()` returns plain functions that queue lines for a fiber forked in the current scope:

```ts
import { makeCallbackLogger } from '@yieldkit/logger';
import { Effect } from 'effect';

const watch = Effect.gen(function* () {
  const log = yield* makeCallbackLogger();
  emitter.on('error', (error) => log.error('socket.error', { message: error.message }));
  emitter.on('reconnect', (attempt) => log.info('socket.reconnect', { attempt }));
});
```

The `CallbackLogger` has `trace`, `debug`, `info`, `warn` and `error`; there is no `fatal`. Each takes a message and optional fields, returns `void`, never blocks and never throws. Fields are read when the call is made, so a `Redactable` fields record (Effect `Headers`) is resolved outside any fiber and uses the default redacted names, not ones a fiber provided.

- Lines are written through the Effect loggers of the fiber that called `makeCallbackLogger`, with its annotations, its minimum level and its span. A line logged inside `Effect.withSpan` carries that span's `traceId` and `spanId`.
- `undefined` fields are dropped, as with the level helpers.
- A line below the creating fiber's minimum level is dropped before it is queued.
- A line a logger fails on is dropped on its own; later lines are still written.
- `makeCallbackLogger` needs a `Scope`. Lines still queued when the scope closes are written first. After that the queue is shut down, and a call is dropped without throwing.
- At most `capacity` lines wait for the writer fiber (default `CALLBACK_LOGGER_CAPACITY`, 1024). A line logged while the queue is full is dropped rather than blocking the caller or growing memory; see [Overflow](#overflow).

## Overflow

A synchronous burst (a listener that fires thousands of times before the fiber runs) can fill the queue. Raise or lower the limit with `makeCallbackLogger({ capacity })`; a value that is not an integer >= 1 makes the effect die.

```ts
const log = yield * makeCallbackLogger({ capacity: 4096 });
```

Dropped lines are reported from the writer fiber, never from the caller:

- every drop is added to the counter `callbackLoggerDropped` (`logger_callback_dropped_total`);
- the first drop of each overflow writes one Warn line, `logger.callback.overflow`, with `capacity` and `droppedTotal` (drops since the logger was created). Another warning comes only after a later line fit in the queue again.

Both are written after the next queued line, so they trail the drops by one line. Drops still unreported when the scope closes are reported before it finishes closing. Calls after the scope closed are dropped without being counted.
