# Callback logger

Code that runs outside a fiber, such as an event emitter listener or a library hook, cannot yield a log effect. `makeCallbackLogger()` returns plain functions that queue lines for a fiber forked in the current scope:

```ts
import { LoggerLive, makeCallbackLogger } from '@yieldkit/logger';
import { Effect, Layer } from 'effect';
import { EventEmitter } from 'node:events';

const emitter = new EventEmitter();

// The callback logger lives as long as this layer.
const SocketLogsLive = Layer.effectDiscard(
  Effect.gen(function* () {
    const log = yield* makeCallbackLogger({ capacity: 4096 }); // capacity is optional
    emitter.on('reconnect', (attempt: number) => log.info('socket.reconnect', { attempt }));
  }),
).pipe(Layer.provide(LoggerLive({ service: 'worker' })));
```

The `CallbackLogger` has `trace`, `debug`, `info`, `warn` and `error` (no `fatal`). Each takes a message and optional fields, returns `void` and never throws.

- Lines are written through the Effect loggers of the fiber that called `makeCallbackLogger`, with its annotations, its minimum level and its span. Lines carry the span that was current when `makeCallbackLogger` ran.
- `undefined` fields are dropped, as with the level helpers.
- A line below the creating fiber's minimum level is dropped before it is queued.
- A line a logger fails on is dropped on its own; later lines are still written.
- `makeCallbackLogger` needs a `Scope`. Lines still queued when the scope closes are written first. After that the queue is shut down, and a call is dropped without throwing.
- At most `capacity` lines wait for the writer fiber (default `CALLBACK_LOGGER_CAPACITY`, 1024), so a synchronous burst can fill the queue. A line logged while the queue is full is dropped rather than blocking the caller or growing memory. A `capacity` that is not an integer >= 1 makes the effect die.
- Drops are counted in `callbackLoggerDropped` (`logger_callback_dropped_total`), and the first drop of each overflow writes one Warn line, `logger.callback.overflow`, with `capacity` and `droppedTotal`. Both are reported from the writer fiber, one line late.
