import { AbstractModule, type InferPublicModuleDependencies } from '../lib/AbstractModule.js'
import type { DependencyInjectionOptions } from '../lib/DIContext.js'
import { asServiceClass, asSingletonFunction } from '../lib/resolverFunctions.js'

export class Logger {
  log(_msg: string): void {}
}

export class EventEmitter {
  emit(_event: string): void {}
}

class Config {
  readonly appName = 'test'
}

export class TestCommonModuleAugmented extends AbstractModule {
  resolveDependencies(_diOptions: DependencyInjectionOptions) {
    return {
      logger: asServiceClass(Logger), // public
      eventEmitter: asServiceClass(EventEmitter), // public
      config: asSingletonFunction(() => new Config()), // private
    }
  }
}

declare module '../lib/AbstractModule.js' {
  interface PublicDependencies extends InferPublicModuleDependencies<TestCommonModuleAugmented> {}
}
