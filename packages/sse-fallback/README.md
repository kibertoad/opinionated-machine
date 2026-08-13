# @opinionated-machine/sse-fallback

Browser-safe client core for **SSE with a transparent polling fallback**, built
around `opinionated-machine` dual-mode contracts (one path serving JSON via
`Accept: application/json` and SSE via `Accept: text/event-stream`).

The client subscribes to the SSE branch for low-latency pushes and keeps a
**deadman timer**: when no data event arrives within the window, it polls the
JSON branch of the same route. A single **version gate** reconciles the two
channels, so app code sees exactly one uniform event stream — whether an event
was pushed, replayed after a reconnect, or synthesized from a poll snapshot is
invisible.

**Zero runtime dependencies.** `zod` and `@lokalise/api-contracts` are
type-only optional peers; nothing from Node.js or Fastify is imported — the
package is safe to ship to browsers (enforced by a source-tree check in CI).

## Why

Push channels fail silently: connections die without an error event, proxies
kill idle streams, a room rebalance drops a message. When the missed
notification gates workflow progress ("upload finished"), the user is stuck.
This package makes **polling the correctness backbone** (bounded staleness,
guaranteed) and SSE the latency optimization — instead of the other way
around.

Two failure detectors run independently:

| Timer | Reset by | Catches |
|---|---|---|
| `staleConnection` | **any bytes** (incl. `: heartbeat` comments) | silently dead connections — force-close + reconnect + poll |
| `deadman` | **data events only** | healthy-but-wrong streams (a dropped message on a live connection) — reconciliation poll |

Heartbeats deliberately do *not* reset the deadman: transport liveness is not
delivery correctness.

## Declaring a binding

The binding is the one thing that cannot be inferred: how a poll snapshot
relates to the SSE events. Declare it once, colocated with the contract:

```ts
import { defineFallbackBinding } from '@opinionated-machine/sse-fallback'

// Use case A — await async completion
export const uploadStatusBinding = defineFallbackBinding(uploadStatusContract, {
  // Translate a snapshot into events; [] = "no news" (still advances the watermark)
  snapshotToEvents: (s) =>
    s.status === 'completed'
      ? [{ event: 'uploadFinished', data: { result: s.result } }]
      : s.status === 'failed'
        ? [{ event: 'uploadFailed', data: { error: s.error } }]
        : [],
  version: { ofSnapshot: (s) => s.version },
  terminalEvents: ['uploadFinished', 'uploadFailed'],
})

// Use case B — initial state load + live hydration
export const projectStateBinding = defineFallbackBinding(projectStateContract, {
  snapshotEvent: 'stateChanged', // shorthand: snapshot body ≡ this event's payload
  version: { ofSnapshot: (s) => s.revision, ofEvent: (e) => e.data.revision, dense: true },
  state: {
    init: (s) => s,
    apply: (state, e) => applyDelta(state, e),
  },
})
```

Escape hatches: `bindFallbackContracts(pollContract, streamContract, config)`
binds two pre-existing contracts on different paths;
`fromLegacyDualModeContract(contract, config)` accepts legacy
`buildSseContract` dual-mode contracts.

## Subscribing

```ts
import { createResilientSubscription } from '@opinionated-machine/sse-fallback'

const sub = createResilientSubscription(uploadStatusBinding, {
  transport,                       // FallbackTransport (see below)
  params: { pathParams: { uploadId } },
})

// Use case A: identical result whether it traveled over SSE or a poll
const { result } = await sub.waitFor('uploadFinished')

// Or consume the uniform stream
for await (const event of sub.events()) { ... }

// Use case B: reduced state
sub.onStateChange((state) => render(state))

sub.status                        // 'connecting' | 'live' | 'reconnecting' | 'polling' | 'stopped'
sub.nudge()                       // force an immediate reconciliation poll
sub.stop()
```

The state machine: `CONNECTING → HYDRATING → LIVE ⇄ RECONNECTING →
POLLING_ONLY → STOPPED`. Hydration is **subscribe-first**: the stream opens,
live events are buffered, the snapshot is fetched, then buffered events newer
than the snapshot are flushed — a zero missed-event window. After N
consecutive connect failures the subscription degrades to pure polling and
keeps probing SSE in the background.

## The version gate

Every event and snapshot carries a version; an item is delivered iff its
version exceeds the high-watermark. This one rule handles:

- **duplicates** — an SSE event followed by a poll snapshot of the same update,
- **the stale-poll race** — a slow poll response arriving *after* a newer
  pushed event is dropped at arrival time,
- **replay overlap** — server-side `Last-Event-ID` replay after reconnects.

`version: 'none'` opts into at-least-once/last-writer-wins semantics as an
adoption bridge — strongly prefer real versions.

## Server-side guarantees (the adopting team's checklist)

1. **Required**: a monotonic version per subscription scope, present in both
   the snapshot body and each event; truthful (a snapshot at version *v*
   reflects every event ≤ *v*). Snapshots must **subsume** prior events.
2. **Recommended**: stamp the SSE `id:` with that version
   (`createEventIdSequence` in `opinionated-machine` helps) — the client's
   default `Number(event.id)` extraction and `Last-Event-ID` replay then
   compose for free.
3. Optional: dense versions (enables gap detection → instant repair polls),
   `onReconnect` replay (declare `replay: 'trusted'` to skip post-reconnect
   polls), heartbeats every ~15s (fast stale detection; correctness holds
   without them).

## Transport

The core owns no HTTP. Implement two functions:

```ts
const transport: FallbackTransport = {
  fetchSnapshot(request, { signal }) { ... },      // Accept: application/json
  openStream(request, { signal, lastEventId }) { ... }, // Accept: text/event-stream,
                                                   // yields decoded text chunks
}
```

`openStream` must yield **raw text chunks** (not parsed events) — the core
parses SSE framing itself and uses chunk arrival as byte-level liveness, so
heartbeat comments count without any transport logic. A scripted
`TestTransport` ships in the package for deterministic fake-timer tests.

## Policy defaults

| Setting | Default | Notes |
|---|---|---|
| `initialPoll` | `'eager'` | closes the startup race for one GET |
| `deadmanDelayMs` | 10 000 | `LIVE_STATE_POLICY` preset: 120 000 |
| `deadmanIdleBackoff` | ×1.5 up to 60 s | quiet subscriptions poll less |
| `staleConnectionTimeoutMs` | 60 000 | `'off'` to disable byte-level liveness |
| `pollFailureBackoff` / `sseRetryBackoff` | 1 s ×2 up to 30 s, full jitter | |
| `degradedAfterFailures` | 3 | then `POLLING_ONLY` |
| `degradedPollIntervalMs` | 15 000 | the "old polling world", kept humane |
| `hydrationBufferLimit` | 1 000 | overflow → drop buffer + refetch |
| `unretryableStatuses` | 401, 403, 404 | stop instead of retrying |

## Known limitations (v1)

- **Snapshots must subsume events.** Append-only feeds where every event
  matters individually and the snapshot only shows the latest item don't fit —
  expose a windowed snapshot (`{ items: [...], version }`) instead.
- **One connection per browser tab.** SharedWorker-based connection sharing
  can be built as an alternative `FallbackTransport` later; `nudge()` /
  `stop()` give visibility-aware wrappers the hooks they need.
- No reorder buffer: on a single TCP stream, gaps are losses, not reorders —
  polling is the repair path.
