import { AbstractModule, type InferPublicModuleDependencies } from '../lib/AbstractModule.js'
import type { DependencyInjectionOptions } from '../lib/DIContext.js'
import { asServiceClass } from '../lib/resolverFunctions.js'

export class BillingService {
  charge(): number {
    return 100
  }
}

export class TestUnimportedModuleAugmented extends AbstractModule {
  resolveDependencies(_diOptions: DependencyInjectionOptions) {
    return {
      billingService: asServiceClass(BillingService), // public
    }
  }
}

declare module '../lib/AbstractModule.js' {
  interface PublicDependencies
    extends InferPublicModuleDependencies<TestUnimportedModuleAugmented> {}
}
