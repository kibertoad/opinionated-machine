# @opinionated-machine/sse-parser

Server-Sent Events parser: the WHATWG event-stream interpreter, with entry
points for a live stream, a `fetch` response, and a body already in memory.

No dependencies, nothing from Node.js or Fastify (enforced by a source-tree
check in CI), so the same code frames a stream in the browser client
(`@opinionated-machine/sse-fallback`) and in the server framework's test
helpers (`opinionated-machine`).

## Install

```sh
npm install @opinionated-machine/sse-parser
```

## Streaming

`createSSEStreamParser()` holds everything that has to survive a chunk
boundary: the partial frame, the `Last-Event-ID` cursor, and the BOM that may
open the stream.

```ts
import { createSSEStreamParser } from '@opinionated-machine/sse-parser'

const parser = createSSEStreamParser({ lastEventId: resumeFrom })

for await (const chunk of decodedChunks) {
  for (const event of parser.push(chunk)) {
    handle(event.event ?? 'message', JSON.parse(event.data))
  }
}

reconnectWith(parser.lastEventId)
```

`push` returns a batch rather than one event at a time because the cursor after
a batch accounts for every frame in it, including id-only frames that dispatch
no event. A caller that gates delivery on the batch needs to see them together.

For the common case, `parseSSEStream` wraps that loop:

```ts
import { parseSSEStream } from '@opinionated-machine/sse-parser'

for await (const event of parseSSEStream(decodedChunks, {
  onChunk: () => resetStaleConnectionTimer(),
})) {
  handle(event)
}
```

`onChunk` fires for every chunk before it is framed, comment frames included.
That matters: framing consumes `: heartbeat` comments, so a consumer watching
only events cannot tell an idle-but-healthy connection from a dead one.

## From a `fetch` response

`parseSSEResponse` does the decode half too, holding back multi-byte characters
split across network chunks and cancelling the body if you stop early.

```ts
import { parseSSEResponse } from '@opinionated-machine/sse-parser'

const response = await fetch(url, { headers: { accept: 'text/event-stream' } })

for await (const event of parseSSEResponse(response)) {
  if (event.event === 'done') break // cancels the response body
}
```

Unlike `EventSource` this is just a parser, so the request is yours: custom
headers, a POST body, an `AbortSignal`, your own reconnect policy.

## From a complete body

```ts
import { parseSSEEvents } from '@opinionated-machine/sse-parser'

const events = parseSSEEvents(response.body) // fastify.inject(), a fixture
```

A trailing frame with no blank line after it is discarded, which is what the
spec requires at the end of a stream: a body cut mid-frame must not surface a
truncated payload as a delivered event. Use `parseSSEBuffer` when you want to
see that leftover.

## What the parser guarantees

| Rule | Why it bites |
|---|---|
| CR, LF and CRLF all terminate a line, and a CR at the end of a chunk is held back | Consuming it early makes the LF that opens the next chunk read as a blank line, splitting one event in two and truncating its data |
| An unterminated frame is never dispatched | A connection dropped mid-frame would otherwise deliver a truncated payload as if the server had sent it whole |
| Exactly one space is stripped after the colon | `data:  two spaces  ` keeps one leading and both trailing spaces, which matters to any decoder reading the raw string instead of JSON |
| `id` and `lastEventId` are separate fields | The cursor is inherited by events carrying no `id:` of their own; consumers that order or deduplicate on the id the event itself carried would drop every inheriting event as a duplicate |
| An id-only frame moves the cursor without dispatching | `parseSSEBuffer` and `createSSEStreamParser` report it, so a reconnect resumes from the right place |
| `data:` with an empty value is an event with an empty payload | The spec's emptiness check runs before the trailing newline is stripped; testing the joined string instead swallows the event |
| `retry:` accepts ASCII digits only | `parseInt` reads `100x` as 100 |
| An `id:` containing a NUL is ignored | The one field value the spec drops outright |
| A leading BOM is stripped once, at the start of the stream | `Buffer.toString('utf8')` keeps it, and it turns the first field name into something the interpreter ignores |

## API

| Export | Use |
|---|---|
| `createSSEStreamParser(options?)` | Stateful incremental parser, one per connection |
| `parseSSEStream(chunks, options?)` | Async iterable of decoded text to events |
| `parseSSEResponse(response, options?)` | `fetch` response body to events |
| `parseSSEEvents(text)` | Complete body to events |
| `parseSSEBuffer(buffer, lastEventId?)` | The primitive: one pass, returns `remaining` and the cursor |
| `stripStreamBOM(text)` | For callers that do their own buffering |
