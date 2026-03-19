import { describe, expect, it } from 'vitest'
import { defineEventMetadata } from './defineEventMetadata.js'

type TestMetadata =
  | { scope: 'project'; projectId: string }
  | { scope: 'team'; teamId: string }
  | { scope: 'global' }

describe('defineEventMetadata', () => {
  describe('guard creation', () => {
    it('should return an object with a guard function for each value', () => {
      const guards = defineEventMetadata<TestMetadata>()('scope', [
        'project',
        'team',
        'global',
      ])

      expect(guards).toHaveProperty('project')
      expect(guards).toHaveProperty('team')
      expect(guards).toHaveProperty('global')
      expect(typeof guards.project).toBe('function')
      expect(typeof guards.team).toBe('function')
      expect(typeof guards.global).toBe('function')
    })

    it('should create guards for string discriminant values', () => {
      const guards = defineEventMetadata<TestMetadata>()('scope', [
        'project',
        'team',
        'global',
      ])

      expect(guards.project({ scope: 'project', projectId: 'p1' })).toBe(true)
    })

    it('should create guards for numeric discriminant values', () => {
      type NumericMetadata =
        | { code: 1; message: string }
        | { code: 2; error: string }

      const guards = defineEventMetadata<NumericMetadata>()('code', [1, 2])

      expect(guards[1]({ code: 1, message: 'ok' })).toBe(true)
      expect(guards[2]({ code: 2, error: 'fail' })).toBe(true)
      expect(guards[1]({ code: 2, error: 'fail' })).toBe(false)
    })
  })

  describe('type narrowing', () => {
    it('should return true when metadata matches the discriminant value', () => {
      const guards = defineEventMetadata<TestMetadata>()('scope', [
        'project',
        'team',
        'global',
      ])

      expect(guards.project({ scope: 'project', projectId: 'p1' })).toBe(true)
      expect(guards.team({ scope: 'team', teamId: 't1' })).toBe(true)
      expect(guards.global({ scope: 'global' })).toBe(true)
    })

    it('should return false when metadata does not match', () => {
      const guards = defineEventMetadata<TestMetadata>()('scope', [
        'project',
        'team',
        'global',
      ])

      expect(guards.project({ scope: 'team', teamId: 't1' })).toBe(false)
      expect(guards.team({ scope: 'global' })).toBe(false)
      expect(guards.global({ scope: 'project', projectId: 'p1' })).toBe(false)
    })

    it('should narrow the type after a positive check', () => {
      const guards = defineEventMetadata<TestMetadata>()('scope', [
        'project',
        'team',
        'global',
      ])

      const metadata: TestMetadata = { scope: 'project', projectId: 'p1' }

      if (guards.project(metadata)) {
        // After narrowing, variant-specific fields are accessible
        expect(metadata.projectId).toBe('p1')
      }

      const teamMeta: TestMetadata = { scope: 'team', teamId: 't1' }

      if (guards.team(teamMeta)) {
        expect(teamMeta.teamId).toBe('t1')
      }
    })
  })

  describe('multiple discriminants', () => {
    it('should work with different discriminant field names', () => {
      type TypedMetadata =
        | { type: 'created'; createdAt: string }
        | { type: 'deleted'; deletedAt: string }

      const guards = defineEventMetadata<TypedMetadata>()('type', ['created', 'deleted'])

      expect(guards.created({ type: 'created', createdAt: '2025-01-01' })).toBe(true)
      expect(guards.deleted({ type: 'deleted', deletedAt: '2025-01-02' })).toBe(true)
      expect(guards.created({ type: 'deleted', deletedAt: '2025-01-02' })).toBe(false)
    })

    it('should produce independent guard functions', () => {
      const guards = defineEventMetadata<TestMetadata>()('scope', [
        'project',
        'team',
        'global',
      ])

      expect(guards.project).not.toBe(guards.team)
      expect(guards.team).not.toBe(guards.global)
      expect(guards.project).not.toBe(guards.global)
    })
  })

  describe('edge cases', () => {
    it('should handle single-variant union', () => {
      type SingleMetadata = { kind: 'only'; value: number }

      const guards = defineEventMetadata<SingleMetadata>()('kind', ['only'])

      expect(guards.only({ kind: 'only', value: 42 })).toBe(true)
    })

    it('should handle empty values array', () => {
      const guards = defineEventMetadata<TestMetadata>()('scope', [])

      expect(Object.keys(guards)).toHaveLength(0)
    })
  })
})
