import {
  AbstractModule,
  type InferModuleDependencies,
  type InferPublicModuleDependencies,
  type PublicDependencies,
} from '../lib/AbstractModule.js'
import type { DependencyInjectionOptions } from '../lib/DIContext.js'
import { asRepositoryClass, asServiceClass } from '../lib/resolverFunctions.js'
import type { Logger } from './TestCommonModuleAugmented.ts'

export type DomainModuleInjectables = InferModuleDependencies<TestDomainModuleAugmented> &
  PublicDependencies

export class UserService {
  private _repository: UserRepository
  private _logger: Logger
  private _config: unknown
  constructor(dependencies: DomainModuleInjectables) {
    this._repository = dependencies.userRepository
    this._logger = dependencies.logger
    // @ts-expect-error This is a private dependency and not exposed
    this._config = dependencies.config
  }

  execute(): string {
    return 'user'
  }
}

class UserRepository {}

export class TestDomainModuleAugmented extends AbstractModule {
  resolveDependencies(_diOptions: DependencyInjectionOptions) {
    return {
      userService: asServiceClass(UserService), // public
      userRepository: asRepositoryClass(UserRepository), // private
    }
  }
}

declare module '../lib/AbstractModule.js' {
  interface PublicDependencies extends InferPublicModuleDependencies<TestDomainModuleAugmented> {}
}
