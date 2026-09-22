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

**One runtime dependency**, `@opinionated-machine/sse-parser`: the SSE
wire-format parser, shared with the server framework's test helpers so both
ends of a stream frame it identically. It is itself dependency-free and
browser-safe. `zod` and `@lokalise/api-contracts` are type-only optional peers,
and nothing from Node.js or Fastify is imported, so the package is safe to ship
to browsers (enforced by a source-tree check in CI).

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
| `deadman` | **delivered events only** | healthy-but-wrong streams: a dropped message on a live connection, repaired by a reconciliation poll |

Heartbeats deliberately do *not* reset the deadman, and neither does a
duplicate the version gate drops: transport liveness is not delivery
correctness. A delivered event pushes the next poll out but does not shorten
the interval back to `deadmanDelayMs`; a stream that keeps delivering needs
less reconciliation, so only a poll that finds news the stream missed resets
the backoff.

## Declaring a binding

The binding is the one thing that cannot be inferred: how a poll snapshot
relates to the SSE events, and whether there is one to relate at all. Declare
it once, colocated with the contract:

```ts
import { defineFallbackBinding } from '@opinionated-machine/sse-fallback'

// Use case A — await async completion
export const uploadStatusBinding = defineFallbackBinding(uploadStatusContract, {
  // The snapshot is a real route the server answers, so polling can carry
  // this subscription on its own. See "Choosing the combination" below.
  snapshotSource: 'endpoint',
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
  snapshotSource: 'endpoint',
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
sub.nudge()                       // force a repair now: a poll, or a reconnect
                                  // when the snapshot is synthesized
sub.streamAbandoned               // true once a refusal took the stream for good
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
| `'unretryable-status'` | refused with a status in `unretryableStatuses` (`status`, `channel`); a stream refusal lands here unless the poll can carry the subscription alone |
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
stream. It needs `snapshotSource: 'endpoint'`, since the poll is then the only
channel there is. The binding, version gate, reconciler and state machine are the same
ones the streaming rollout will use, so enabling SSE later is a config change
on an already-integrated subscription rather than a second migration.

The state machine: `CONNECTING → HYDRATING → LIVE ⇄ RECONNECTING →
POLLING_ONLY → STOPPED`. Hydration is **subscribe-first**: the stream opens,
live events are buffered, the snapshot is fetched, then buffered events newer
than the snapshot are flushed — a zero missed-event window. After N
consecutive connect failures the subscription degrades to pure polling and
keeps probing SSE in the background.

One route into `POLLING_ONLY` never probes again: when a stream is refused
with an unretryable status and the poll carries the subscription on, the
stream is given up for the life of the subscription.
`subscription.streamAbandoned` is what separates that from ordinary
degradation, since both report `status: 'polling'`, and
`diagnostics.onStreamRefused` reports the moment it happens.

A binding whose snapshot is synthesized never reaches `POLLING_ONLY` at all:
there is no poll to fall back to, so the machine is `CONNECTING → LIVE ⇄
RECONNECTING → STOPPED` and a stream that is down reports `'reconnecting'`
for as long as it stays down.

## Choosing the combination

Three knobs decide what happens when something goes wrong: `snapshotSource` on
the binding, `mode` and `streamRefusal` on the policy. Only `snapshotSource`
has no default, because it is the only one the package cannot work out for
itself. A binding whose snapshot is answered locally is structurally identical
to one backed by a real route, and the difference only shows up at runtime, as
polls that return 200 and carry nothing.

| Surface | `snapshotSource` | `mode` | `streamRefusal` | Also |
|---|---|---|---|---|
| Await an async operation | `'endpoint'` | `'dual'` | `'auto'` | `subscriptionBudget` |
| Live view with a read route | `'endpoint'` | `'dual'` | `'auto'` | `LIVE_STATE_POLICY` |
| Live view where latency is the product | `'endpoint'` | `'dual'` | `'stop'` | `LIVE_STATE_POLICY` |
| Transitions no read reproduces | `'synthesized'` | `'dual'` | `'auto'` | repair on reconnect |
| SSE route not built yet | `'endpoint'` | `'poll-only'` | not read | `POLL_ONLY_POLICY` |

### Awaiting an async operation

An upload, an export, a long import: one subscription, one terminal event,
then it is over. The snapshot route already exists, because the page rendered
the operation before it subscribed, so the poll is the correctness backbone
and SSE only makes it feel instant.

```ts
export const uploadStatusBinding = defineFallbackBinding(uploadStatusContract, {
  snapshotSource: 'endpoint',
  snapshotToEvents: (s) =>
    s.status === 'completed' ? [{ event: 'uploadFinished', data: { result: s.result } }] : [],
  version: { ofSnapshot: (s) => s.version },
  terminalEvents: ['uploadFinished'],
})

const sub = createResilientSubscription(uploadStatusBinding, {
  transport,
  params: { pathParams: { uploadId } },
  // A backend stuck in 'pending' would otherwise poll until the tab closes.
  policy: { subscriptionBudget: { maxDurationMs: 10 * 60_000, maxPolls: 200 } },
})
const { result } = await sub.waitFor('uploadFinished')
```

Everything else is default and should stay that way. `initialPoll: 'eager'`
hydrates from the snapshot before the first event, so an operation that
finished before the subscription opened still resolves the wait.
`streamRefusal: 'auto'` resolves to keeping the poll: a refused SSE route
costs the instant feel, not the result. The budget is the one addition worth
making, because a wait that never ends is worse than one that fails.

### A live view with a read route

A list or a state view that stays mounted: rows updating as an import
progresses, a counter on a dashboard. The read route exists because the list
had to load, so both channels work and the poll covers whatever the stream
misses.

```ts
export const uploadedItemsBinding = bindFallbackContracts(
  GET_UPLOADED_ITEMS_CONTRACT,
  GET_UPLOADED_ITEMS_SUBSCRIBE_CONTRACT,
  {
    snapshotSource: 'endpoint',
    snapshotToEvents: (snapshot) =>
      snapshot.data.map((item) => ({ event: 'upload_item.changed', data: item })),
    version: 'none',
  },
)

createResilientSubscription(uploadedItemsBinding, {
  transport,
  params,
  // Permanently mounted, so poll slowly while idle and nudge() on user intent.
  policy: LIVE_STATE_POLICY,
})
```

`LIVE_STATE_POLICY` stretches the idle deadman to 120s backing off to 300s, so
a tab left open overnight is not a polling machine, and holds the degraded
cadence at 60s for when the stream is gone. No budget here: the subscription
should outlive anything the user is doing. `nudge()` is the way back to fast,
for the moment a user does something that ought to show a result now.

### Transitions no read reproduces

Some events are not state. "This batch of segments was re-translated", "the
search index caught up", "word counts were recalculated": no `GET` returns
them, so a poll has nothing to fetch. The transport answers the snapshot
channel locally, and the binding says so.

```ts
const pushOnlyTransport: FallbackTransport = {
  openStream: (request, opts) => streamTransport.openStream(request, opts),
  fetchSnapshot: () => Promise.resolve({ status: 200, headers: {}, body: {} }),
}

const binding: FallbackBinding<unknown, SegmentEvents> = {
  config: { snapshotSource: 'synthesized', snapshotToEvents: () => [], version: 'none' },
  buildSnapshotRequest: () => ({ path: '', method: 'get' }), // never dispatched
  buildStreamRequest: (params) => ({ path: streamPath(params), method: 'get' }),
}
```

`'synthesized'` switches the poll channel off rather than running it into a
wall: no hydration poll, no deadman, no fallback cadence, and `nudge()`
reconnects a silent stream instead of fetching nothing. The status machine
loses `'polling'`, since there is nothing to poll, and a stream that is down
reports `'reconnecting'`.

A refused stream stops the subscription, which is what this shape wants: the
stop is the only signal that live updates are gone, and something has to act
on it. Repair after a reconnect is the consumer's too, since only they know
what to re-read:

```ts
sub.onStatusChange((status) => {
  if (status === 'live') queryClient.invalidateQueries({ queryKey: ['segments', projectId] })
  if (status === 'stopped') reportToErrorTracker('live segment updates are off')
})
```

A snapshot route that exists but cannot be expressed as events belongs here
too. An endpoint that answers 204 when no process is running gives
`snapshotToEvents` nothing to return, and a read model that ten call sites
already share through a query cache is better invalidated on reconnect than
duplicated into the version gate.

### Latency is the product

A cursor position, a presence dot, a live-typing badge. A 15s poll is not a
degraded version of those, it is a different feature that happens to return
data.

```ts
createResilientSubscription(presenceBinding, {
  transport,
  policy: { ...LIVE_STATE_POLICY, streamRefusal: 'stop' },
})
```

The snapshot stays `'endpoint'`, because it exists and hydration uses it. What
changes is the meaning of a refusal: `'stop'` hands the surface one clear
signal to hide the indicator, instead of a cadence nobody perceives as live.

### Combinations the constructor rejects

Both throw at `createResilientSubscription`, rather than at the first failure
hours later:

- `mode: 'poll-only'` with `snapshotSource: 'synthesized'`. No stream is ever
  opened and the poll delivers nothing, so the subscription could only sit
  there.
- `streamRefusal: 'keep-polling'` with `snapshotSource: 'synthesized'`. The
  poll cannot stand in for a refused stream, so the subscription would report
  itself healthy and deliver nothing.

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
   epochs, so every alternation between them reads as an epoch change and costs
   a resync poll. For multi-writer scopes use a domain version or the
   Redis-backed
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
| `deadmanIdleBackoff` | ×1.5 up to 60 s | quiet subscriptions poll less; only a poll that finds news resets it |
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
| `streamRefusal` | `'auto'` | follows `snapshotSource`: keep polling on an endpoint snapshot, stop on a synthesized one |
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

The epoch is a string of digits, which is what makes `<digits>-<digits>` an
unambiguous marker for a generated id: a UUID matches `<anything>-<digits>` too,
and reading a chunk of one as a counter would order events at random. The
server-side generators refuse a non-numeric epoch for that reason, so every id
they produce is one this extractor can order.

An epoch change is a resynchronization point, not a measurable gap: the counters
on either side are unrelated, so the reconciler reports it as a gap with
`reason: 'epoch-change'`, polls for a snapshot, and rebuilds delta state from it
rather than applying more deltas across the restart.

That holds in **either direction**. A new epoch is not necessarily a larger one:
moving a writer from `createEventIdSequence()` (epoch seeded from `Date.now()`)
to `createRedisEventIdSequence()` (epoch `'0'` by default) lowers it. The epoch
is compared before the duplicate gate for exactly that reason — ranking the new
scope as "older" would drop every event and snapshot that followed it, forever.
The new epoch simply becomes the ordering scope, and the resync poll repairs
whatever the switch skipped. This applies to the default comparator only: a
binding that declares `version.compare` owns ordering end to end, epochs
included, and its verdict is never overridden.

Ids in any other shape (a UUID, say) carry **no** version: they are unique but
not orderable, so events are delivered at-least-once and the watermark does not
move. Declare `version.ofEvent` explicitly for any other id scheme rather than
letting an unorderable id masquerade as a version.

The same rule protects the gate from a version it cannot order at all —
`version.ofSnapshot` returning `undefined` because the body has no version
field, or `NaN`, or an empty string. Such a value is never stored as the
watermark (one that compares as "not less than" everything would drop the whole
stream as duplicates); the item is delivered, the watermark stays put, and
`diagnostics.onInvalidVersion` reports the degradation to at-least-once, which
is otherwise invisible.

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
