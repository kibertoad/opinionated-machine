import { describe, expect, it } from 'vitest'
import { buildSSERouteField, mergeSSERouteField } from './sseRouteConfig.ts'

describe('buildSSERouteField', () => {
  it('returns the bare kind when no options are set', () => {
    expect(buildSSERouteField('only')).toBe('only')
    expect(buildSSERouteField('manual', {})).toBe('manual')
  })

  it('includes the serializer and keeps the plugin heartbeat when only a serializer is set', () => {
    const serializer = (data: unknown) => JSON.stringify(data)
    expect(buildSSERouteField('only', { serializer })).toEqual({ kind: 'only', serializer })
  })

  it('disables the plugin heartbeat when a route-level interval is set', () => {
    expect(buildSSERouteField('only', { heartbeatInterval: 5000 })).toEqual({
      kind: 'only',
      heartbeat: false,
    })
  })

  it('disables the plugin heartbeat when heartbeats are explicitly off (0 / false)', () => {
    expect(buildSSERouteField('manual', { heartbeatInterval: 0 })).toEqual({
      kind: 'manual',
      heartbeat: false,
    })
    expect(buildSSERouteField('manual', { heartbeatInterval: false })).toEqual({
      kind: 'manual',
      heartbeat: false,
    })
  })

  it('combines serializer and heartbeat handling', () => {
    const serializer = (data: unknown) => String(data)
    expect(buildSSERouteField('manual', { serializer, heartbeatInterval: 100 })).toEqual({
      kind: 'manual',
      serializer,
      heartbeat: false,
    })
  })
})

describe('mergeSSERouteField', () => {
  it('upgrades a bare kind to the object form', () => {
    const serializer = (data: unknown) => String(data)
    expect(mergeSSERouteField('only', { serializer })).toEqual({ kind: 'only', serializer })
  })

  it('keeps a route-level serializer over the registration-time one', () => {
    const routeSerializer = (data: unknown) => String(data)
    const registrationSerializer = (data: unknown) => JSON.stringify(data)
    expect(
      mergeSSERouteField(
        { kind: 'manual', serializer: routeSerializer },
        { serializer: registrationSerializer },
      ),
    ).toEqual({ kind: 'manual', serializer: routeSerializer })
  })

  it('adds heartbeat: false when the plugin heartbeat should be disabled', () => {
    expect(mergeSSERouteField('only', { disablePluginHeartbeat: true })).toEqual({
      kind: 'only',
      heartbeat: false,
    })
  })

  it('never removes an existing heartbeat: false', () => {
    expect(mergeSSERouteField({ kind: 'only', heartbeat: false }, {})).toEqual({
      kind: 'only',
      heartbeat: false,
    })
  })

  it('treats a legacy `true` value as kind-less back-compat (kind omitted)', () => {
    const serializer = (data: unknown) => String(data)
    expect(mergeSSERouteField(true, { serializer })).toEqual({ serializer })
  })
})
