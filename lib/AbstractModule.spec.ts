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

  it('maps non-public dependencies to never', () => {
    type PublicDeps = InferPublicModuleDependencies<TestModule>

    // raw asClass → private, mapped to never
    expectTypeOf<PublicDeps['testExpendable']>().toBeNever()
    // asMessageQueueHandlerClass → private, mapped to never
    expectTypeOf<PublicDeps['messageQueueConsumer']>().toBeNever()
    // asEnqueuedJobWorkerClass → private, mapped to never
    expectTypeOf<PublicDeps['jobWorker']>().toBeNever()
    // asPeriodicJobClass → private, mapped to never
    expectTypeOf<PublicDeps['periodicJob']>().toBeNever()
  })

  it('prevents injection of private deps through AvailableDependencies', () => {
    type PublicDeps = InferPublicModuleDependencies<TestModuleSecondary>
    type Deps = AvailableDependencies<PublicDeps>

    // public dep is properly typed
    expectTypeOf<Deps['testServiceSecondary']>().toEqualTypeOf<TestServiceSecondary>()
    // private dep is never — not any
    expectTypeOf<Deps['testRepository']>().toBeNever()
    // unknown dep falls through to any via index signature
    expectTypeOf<Deps['somethingElse']>().toBeAny()
  })
})

describe('AvailableDependencies', () => {
  it('provides typed access for external public deps and any for local deps', () => {
    type PublicDeps = InferPublicModuleDependencies<TestModuleSecondary>
    type Deps = AvailableDependencies<PublicDeps>

    // public dep from external module — fully typed
    expectTypeOf<Deps['testServiceSecondary']>().toEqualTypeOf<TestServiceSecondary>()
    // private dep from external module — blocked as never
    expectTypeOf<Deps['testRepository']>().toBeNever()
    // local dep (not in any known type) — falls through to any via index signature
    expectTypeOf<Deps['testFunction']>().toBeAny()
  })

  it('supports combining multiple external public dep types', () => {
    type CombinedPublicDeps = InferPublicModuleDependencies<TestModuleSecondary> &
      InferPublicModuleDependencies<TestModule>
    type Deps = AvailableDependencies<CombinedPublicDeps>

    // public deps from TestModuleSecondary
    expectTypeOf<Deps['testServiceSecondary']>().toEqualTypeOf<TestServiceSecondary>()
    // public deps from TestModule
    expectTypeOf<Deps['testService']>().toEqualTypeOf<TestService>()
    // private dep from TestModuleSecondary — still blocked
    expectTypeOf<Deps['testRepository']>().toBeNever()
    // private dep from TestModule — still blocked
    expectTypeOf<Deps['testExpendable']>().toBeNever()
    // unknown dep — any
    expectTypeOf<Deps['unknownDep']>().toBeAny()
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
