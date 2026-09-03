import { describe, expect, it } from 'vitest'
import { defineRoom } from './defineRoom.js'

describe('defineRoom', () => {
  it('returns a function that produces correct room names with a single param', () => {
    const dashboardRoom = defineRoom<{ dashboardId: string }>(
      ({ dashboardId }) => `dashboard:${dashboardId}`,
    )

    expect(dashboardRoom({ dashboardId: 'abc-123' })).toBe('dashboard:abc-123')
    expect(dashboardRoom({ dashboardId: 'xyz' })).toBe('dashboard:xyz')
  })

  it('returns a function that produces correct room names with multiple params', () => {
    const projectChannelRoom = defineRoom<{ projectId: string; channelId: string }>(
      ({ projectId, channelId }) => `project:${projectId}:channel:${channelId}`,
    )

    expect(projectChannelRoom({ projectId: 'p1', channelId: 'general' })).toBe(
      'project:p1:channel:general',
    )
  })

  it('works with numeric params', () => {
    const paginatedRoom = defineRoom<{ page: number }>(({ page }) => `feed:page:${page}`)

    expect(paginatedRoom({ page: 42 })).toBe('feed:page:42')
  })

  it('returns a function (identity wrapper)', () => {
    const resolver = ({ id }: { id: string }) => `room:${id}`
    const room = defineRoom(resolver)

    expect(room).toBe(resolver)
  })
})
