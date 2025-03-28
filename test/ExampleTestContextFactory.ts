import { AbstractTestContextFactory } from '../lib/AbstractTestContextFactory.js'
import { TestModule, type TestModuleDependencies } from './TestModule.js'

// biome-ignore lint/complexity/noBannedTypes: <explanation>
type ExternalDependencies = {}

// biome-ignore lint/complexity/noBannedTypes: <explanation>
type Config = {}

export class ExampleTestContextFactory extends AbstractTestContextFactory<
  TestModuleDependencies,
  ExternalDependencies,
  Config
> {
  constructor() {
    super({}, [new TestModule()])
  }

  resolveBaseAppConfig(): Config {
    return {}
  }
}

export const testContextFactory = new ExampleTestContextFactory()
