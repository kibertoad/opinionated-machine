import { createContainer } from 'awilix'
import { describe, expect, it } from 'vitest'
import { mergeConfigAndDependencyOverrides } from '../lib/configUtils.js'

describe('configUtils', () => {
  describe('mergeConfigAndDependencyOverrides', () => {
    type TestConfig = {
      database: {
        host: string
        port: number
      }
      features: {
        enabled: boolean
      }
    }

    const baseConfig: TestConfig = {
      database: {
        host: 'localhost',
        port: 5432,
      },
      features: {
        enabled: false,
      },
    }

    it('returns dependencyOverrides when configOverrides is undefined', () => {
      const dependencyOverrides = { someDep: {} }

      const result = mergeConfigAndDependencyOverrides<{ someDep: object }, TestConfig>(
        baseConfig,
        'config',
        undefined,
        dependencyOverrides as never,
      )

      expect(result).toBe(dependencyOverrides)
    })

    it('merges config overrides and returns new dependency overrides', () => {
      const container = createContainer({ injectionMode: 'PROXY' })

      const result = mergeConfigAndDependencyOverrides<{ config: TestConfig }, TestConfig>(
        baseConfig,
        'config',
        { database: { port: 3306 } },
        undefined,
      )

      expect(result).toBeDefined()
      expect(result).toHaveProperty('config')

      // Register and resolve to verify the merge works
      container.register(result!)
      const resolvedConfig = container.cradle.config

      expect(resolvedConfig.database.host).toBe('localhost')
      expect(resolvedConfig.database.port).toBe(3306)
      expect(resolvedConfig.features.enabled).toBe(false)
    })

    it('preserves existing dependency overrides when merging config', () => {
      const container = createContainer({ injectionMode: 'PROXY' })
      const existingOverrides = {
        otherDep: { resolve: () => 'other' },
      }

      const result = mergeConfigAndDependencyOverrides<
        { config: TestConfig; otherDep: string },
        TestConfig
      >(baseConfig, 'config', { features: { enabled: true } }, existingOverrides as never)

      expect(result).toHaveProperty('config')
      expect(result).toHaveProperty('otherDep')

      container.register(result!)
      const resolvedConfig = container.cradle.config

      expect(resolvedConfig.features.enabled).toBe(true)
    })
  })
})
