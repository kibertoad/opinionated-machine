import type { BuildResolver, DisposableResolver } from 'awilix'
import { describe, expectTypeOf, it } from 'vitest'
import { type TestModule, TestService } from '../test/TestModule.ts'
import {
  type TestModuleSecondary,
  TestRepository,
  type TestServiceSecondary,
} from '../test/TestModuleSecondary.ts'
import type {
  AvailableDependencies,
  InferModuleDependencies,
  InferPublicModuleDependencies,
  InferStrictPublicModuleDependencies,
} from './AbstractModule.ts'
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

describe('InferStrictPublicModuleDependencies', () => {
  it('maps public dependencies to their unwrapped types', () => {
    type StrictDeps = InferStrictPublicModuleDependencies<TestModule>

    expectTypeOf<StrictDeps['testService']>().toEqualTypeOf<TestService>()
  })

  it('maps non-public dependencies to never', () => {
    type StrictDeps = InferStrictPublicModuleDependencies<TestModule>

    expectTypeOf<StrictDeps['testExpendable']>().toBeNever()
    expectTypeOf<StrictDeps['messageQueueConsumer']>().toBeNever()
    expectTypeOf<StrictDeps['jobWorker']>().toBeNever()
    expectTypeOf<StrictDeps['periodicJob']>().toBeNever()
  })

  it('maps secondary module private deps to never', () => {
    type StrictDeps = InferStrictPublicModuleDependencies<TestModuleSecondary>

    expectTypeOf<StrictDeps['testServiceSecondary']>().toEqualTypeOf<TestServiceSecondary>()
    expectTypeOf<StrictDeps['testRepository']>().toBeNever()
  })
})

describe('AvailableDependencies', () => {
  it('provides any for unknown keys when used without type params', () => {
    type Deps = AvailableDependencies
    expectTypeOf<Deps['anything']>().toBeAny()
  })

  it('provides typed access for known deps and any for unknown keys', () => {
    type Known = { testService: TestService }
    type Deps = AvailableDependencies<Known>

    expectTypeOf<Deps['testService']>().toEqualTypeOf<TestService>()
    expectTypeOf<Deps['unknownDep']>().toBeAny()
  })

  it('preserves never for strict public deps (prevents accessing private deps from other modules)', () => {
    type StrictDeps = InferStrictPublicModuleDependencies<TestModuleSecondary>
    type Deps = AvailableDependencies<StrictDeps>

    // public dep is typed
    expectTypeOf<Deps['testServiceSecondary']>().toEqualTypeOf<TestServiceSecondary>()
    // private dep stays never (not overridden by index signature)
    expectTypeOf<Deps['testRepository']>().toBeNever()
    // unknown dep is any
    expectTypeOf<Deps['localDep']>().toBeAny()
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
