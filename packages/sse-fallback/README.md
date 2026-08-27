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

### Why it stopped

`'stopped'` alone cannot be acted on: a completed job, an expired session and
a caller's own `stop()` all land there. Every stop carries a reason:

```ts
sub.onStop(({ reason, status, limit }) => { ... })
sub.onStatusChange((status, detail) => { ... })   // detail is set for 'stopped'
sub.result                                        // undefined while running

try {
  await sub.waitFor('uploadFinished')
} catch (error) {
  if (error instanceof SubscriptionStoppedError && error.reason === 'budget-exhausted') {
    showRetryPrompt()
  }
}
```

| `reason` | Meaning |
|---|---|
| `'terminal-event'` | a terminal event was delivered — success |
| `'unretryable-status'` | refused with a status in `unretryableStatuses` (`status`, `channel`) |
| `'budget-exhausted'` | `subscriptionBudget` ran out (`limit`) — show an error and offer a retry |
| `'manual'` | the caller called `stop()`, or the creation `signal` aborted |

### Bounding a pending operation

Every individual wait is bounded, but the subscription as a whole is not: a
backend stuck in a pending state deadman-polls until the tab closes. For
pending-completion subscriptions, declare a ceiling:

```ts
createResilientSubscription(binding, {
  transport,
  policy: { subscriptionBudget: { maxDurationMs: 10 * 60_000, maxPolls: 200 } },
})
```

Unset by default, so a live-state surface keeps running for as long as it is
open.

### Recovering from an expired token

A 401 in a SPA is usually an expired token rather than a genuinely
unauthorized caller, and recovering without a page reload is the point of this
package. Give it a way to refresh:

```ts
createResilientSubscription(binding, {
  transport,
  onAuthChallenge: async () => {
    await auth.refresh()        // the transport builds each request fresh
    return true                 // retry the refused poll/connect once
  },
})
```

The retry is granted once per failure streak: a second refusal with no
successful request in between stops the subscription with
`'unretryable-status'`.

### Adopting before the SSE endpoint exists

`policy.mode: 'poll-only'` (or the `POLL_ONLY_POLICY` preset) never opens a
stream. The binding, version gate, reconciler and state machine are the same
ones the streaming rollout will use, so enabling SSE later is a config change
on an already-integrated subscription rather than a second migration.

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
2. **Recommended**: stamp the SSE `id:` with that version — the client's
   default extraction (bare integers and `createEventIdSequence()` ids alike)
   and `Last-Event-ID` replay then compose for free. Prefer a domain version
   (`job.version`, a revision column) as the id source: it is per-scope and
   writer-independent. A per-process `createEventIdSequence()` is safe only for
   a single writer — two pods sequencing into the same room use different
   epochs, and the client silently drops the older-epoch pod's events. For
   multi-writer scopes use a domain version or the Redis-backed
   `createRedisEventIdSequence()` from
   `@opinionated-machine/sse-rooms-redis`.
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

`openStream` should yield **raw text chunks** — the core parses SSE framing
itself and uses chunk arrival as byte-level liveness, so heartbeat comments
count without any transport logic. A scripted `TestTransport` ships in the
package for deterministic fake-timer tests.

### Wrapping a client that only exposes parsed events

`EventSource` cannot expose comment frames at all, and an HTTP client whose
SSE mode yields events rather than text has already dropped them. `openStream`
may resolve with an `events: AsyncIterable<ParsedSseFrame>` instead of
`chunks`:

```ts
openStream(request, { signal, lastEventId }) {
  return { status: 200, headers, events: client.stream(request) }
}
```

The cost is liveness, not correctness: `staleConnectionTimeoutMs` degrades
from byte-level to EVENT-level, so a stream carrying only heartbeat *comments*
looks idle and is force-closed at the timeout, and a silently dead connection
is only noticed once it elapses. Heartbeat *events* (a named event rather than
a comment) still reset it, and the deadman poll is unaffected. Prefer raw
chunks where the client allows it.

### Capping polls across subscriptions

Each subscription jitters its own backoff, which says nothing about the others
in the same tab: after a server blip every live subscription reconnects and
fires its own reconciliation poll at once. An app running dozens of
subscriptions turns one outage into a burst of dozens of requests against one
origin.

Share a gate between the subscriptions that should be capped together —
normally one per origin:

```ts
import { createPollGate } from '@opinionated-machine/sse-fallback'

const pollGate = createPollGate({ maxConcurrent: 4, staggerMs: 2_000 })
createResilientSubscription(binding, { transport, pollGate })
```

A gate delays polls, never cancels them: a subscription waiting for a slot
keeps its in-flight latch, so its deadman does not stack a second poll behind
the first. Without a gate, capping and staggering are the transport's
responsibility.

## Policy defaults

| Setting | Default | Notes |
|---|---|---|
| `initialPoll` | `'eager'` | closes the startup race for one GET |
| `deadmanDelayMs` | 10 000 | `LIVE_STATE_POLICY` preset: 120 000 |
| `deadmanIdleBackoff` | ×1.5 up to 60 s | quiet subscriptions poll less |
| `staleConnectionTimeoutMs` | 60 000 | `'off'` to disable byte-level liveness |
| `connectTimeoutMs` | 15 000 | a connect that never sends headers is a failure, not a stall |
| `pollTimeoutMs` | 10 000 | a poll that never settles would disable the backbone |
| `pollFailureBackoff` / `sseRetryBackoff` | 1 s ×2 up to 30 s, full jitter | |
| `serverRetryHintBounds` | 250 ms – 60 s | clamps the server's `retry:` hint |
| `degradedAfterFailures` | 3 | then `POLLING_ONLY` |
| `degradedPollIntervalMs` | 15 000 | the "old polling world", kept humane |
| `hydrationBufferLimit` | 1 000 | overflow → drop buffer + refetch |
| `hydrationAbandonAfterFailures` | 3 | flush the buffer rather than silence a healthy stream |
| `unretryableStatuses` | 401, 403, 404 | stop instead of retrying |
| `authChallengeStatuses` | 401 | offered to `onAuthChallenge` before giving up |
| `mode` | `'dual'` | `'poll-only'` never opens a stream |
| `subscriptionBudget` | unset | `{ maxDurationMs, maxPolls }` — a hard give-up bound |

Every wait in the machine is bounded, because an unbounded one turns the
fallback into no fallback at all: a hung connect or a poll that never settles
would leave nothing armed, which is precisely the silent-failure class this
package exists to catch.

## Event ids and the version gate

The default version extractor reads the SSE `id:` and accepts two shapes: a
bare integer (`"42"`), and the `"<epoch>-<counter>"` ids produced by the
server-side `createEventIdSequence()`. Sequence ids order by epoch first and
then counter, so a process restart — a new, larger epoch with the counter back
at 1 — reads as *newer*, not as a flood of duplicates.

Ids in any other shape (a UUID, say) carry **no** version: they are unique but
not orderable, so events are delivered at-least-once and the watermark does not
move. Declare `version.ofEvent` explicitly for any other id scheme rather than
letting an unorderable id masquerade as a version.

## Known limitations (v1)

- **Snapshots must subsume events.** Append-only feeds where every event
  matters individually and the snapshot only shows the latest item don't fit —
  expose a windowed snapshot (`{ items: [...], version }`) instead.
- **One subscription is one physical SSE connection.** The binding model is
  per-resource, so a tab with several pending jobs plus a live-state surface
  opens one stream each. Under HTTP/1.1 that runs into the ~6-connections-per-
  origin browser cap.

  The position this package takes: per-resource streams are the recommended
  model **behind an HTTP/2 gateway**, which removes the cap — the Envoy config
  generated by `@opinionated-machine/gateway-envoy` in this repo is where that
  is configured — and the per-scope snapshot/version model is what makes the
  fallback correct in the first place. Where h2 cannot be relied on, stream
  sharing is the roadmap item: either a SharedWorker `FallbackTransport`, or a
  transport-level multiplexer where N logical subscriptions share one physical
  stream keyed by contract + params, each keeping its own version gate.
  `bindFallbackContracts` binds one poll to one stream today, so the
  multiplexer is the missing piece for a user-wide stream.
  `nudge()` / `stop()` give visibility-aware wrappers the hooks they need.
- No reorder buffer: on a single TCP stream, gaps are losses, not reorders —
  polling is the repair path.
