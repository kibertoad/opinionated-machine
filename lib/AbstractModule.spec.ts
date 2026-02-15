import type { BuildResolver, DisposableResolver } from 'awilix'
import { describe, expectTypeOf, it } from 'vitest'
import { type TestModule, TestService } from '../test/TestModule.ts'
import {
  type TestModuleSecondary,
  TestRepository,
  type TestServiceSecondary,
} from '../test/TestModuleSecondary.ts'
import type { InferModuleDependencies, InferPublicModuleDependencies } from './AbstractModule.ts'
import type { PublicResolver } from './resolverFunctions.ts'
import {
  asRepositoryClass,
  asServiceClass,
  asSingletonClass,
  asSingletonFunction,
} from './resolverFunctions.ts'

describe('InferModuleDependencies', () => {
  it('resolves all dependency keys with unwrapped types', () => {
    type Deps = InferModuleDependencies<TestModuleSecondary>

    expectTypeOf<Deps['testServiceSecondary']>().toEqualTypeOf<TestServiceSecondary>()
    expectTypeOf<Deps['testRepository']>().toEqualTypeOf<TestRepository>()
  })
})

describe('InferPublicModuleDependencies', () => {
  it('resolves public dependencies to their unwrapped types', () => {
    type PublicDeps = InferPublicModuleDependencies<TestModule>

    // asServiceClass → public, resolved to unwrapped type
    expectTypeOf<PublicDeps['testService']>().toEqualTypeOf<TestService>()
    // asJobQueueClass → public
    expectTypeOf<PublicDeps>().toHaveProperty('queue')
    // asEnqueuedJobQueueManagerFunction → public
    expectTypeOf<PublicDeps>().toHaveProperty('queueManager')
  })

  it('omits non-public dependencies from the type', () => {
    type PublicDeps = InferPublicModuleDependencies<TestModule>

    // private resolvers are omitted entirely
    expectTypeOf<PublicDeps>().not.toHaveProperty('testExpendable')
    expectTypeOf<PublicDeps>().not.toHaveProperty('messageQueueConsumer')
    expectTypeOf<PublicDeps>().not.toHaveProperty('jobWorker')
    expectTypeOf<PublicDeps>().not.toHaveProperty('periodicJob')
  })

  it('omits private deps from secondary module public type', () => {
    type PublicDeps = InferPublicModuleDependencies<TestModuleSecondary>

    // public dep is properly typed
    expectTypeOf<PublicDeps['testServiceSecondary']>().toEqualTypeOf<TestServiceSecondary>()
    // private dep is omitted
    expectTypeOf<PublicDeps>().not.toHaveProperty('testRepository')
  })
})

describe('PublicResolver conditional branding', () => {
  it('public-by-default resolver returns PublicResolver', () => {
    expectTypeOf(asServiceClass(TestService)).toExtend<PublicResolver<TestService>>()
  })

  it('public-by-default resolver drops brand with { public: false }', () => {
    const result = asServiceClass(TestService, { public: false })
    expectTypeOf(result).toExtend<BuildResolver<TestService> & DisposableResolver<TestService>>()
    expectTypeOf(result).not.toExtend<PublicResolver<TestService>>()
  })

  it('private-by-default resolver is not branded', () => {
    expectTypeOf(asRepositoryClass(TestRepository)).not.toExtend<PublicResolver<TestRepository>>()
    expectTypeOf(asSingletonClass(TestService)).not.toExtend<PublicResolver<TestService>>()
  })

  it('private-by-default resolver gains brand with { public: true }', () => {
    expectTypeOf(asSingletonClass(TestService, { public: true })).toExtend<
      PublicResolver<TestService>
    >()
    expectTypeOf(
      asSingletonFunction(() => new TestService(null as any), { public: true }),
    ).toExtend<PublicResolver<TestService>>()
  })
})
