import type { SSEMessage } from 'opinionated-machine'
import type { RedisRoomMessage } from '../types.ts'

/**
 * Encode an outgoing message for the wire format `{ v: 1, m, n, meta? }`.
 *
 * `meta` is intentionally omitted (rather than serialised as `undefined`)
 * when no metadata is provided — `JSON.stringify` already drops `undefined`,
 * but doing it explicitly keeps the wire schema clean across both encoders
 * and lets readers distinguish "no metadata attached" from "metadata field
 * present but null".
 */
export function encodePayload(
  message: SSEMessage,
  nodeId: string,
  metadata?: Record<string, unknown>,
): string {
  const payload: RedisRoomMessage = { v: 1, m: message, n: nodeId }
  if (metadata !== undefined) {
    payload.meta = metadata
  }
  return JSON.stringify(payload)
}

/**
 * Result of decoding an incoming wire payload.
 *
 * `null` means "drop this message" — either the JSON was malformed or the
 * protocol version is one we don't understand. The adapter treats both the
 * same way: silently skip.
 */
export type DecodedPayload = {
  message: SSEMessage
  sourceNodeId: string
  metadata?: Record<string, unknown>
}

export function decodePayload(rawMessage: string): DecodedPayload | null {
  try {
    const payload = JSON.parse(rawMessage) as RedisRoomMessage
    if (payload.v !== 1) {
      return null
    }
    return {
      message: payload.m,
      sourceNodeId: payload.n,
      metadata: payload.meta,
    }
  } catch {
    return null
  }
}
