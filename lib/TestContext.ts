import {type AwilixContainer, createContainer, type NameAndRegistrationPair} from "awilix";
import {type DependencyInjectionOptions, DIContext} from './DIContext.js';
import {AwilixManager} from "awilix-manager";
import {merge} from "ts-deepmerge";
import {asSingletonFunction} from './resolverFunctions.js';
import type {AbstractModule} from "./AbstractModule";

type NestedPartial<T> = {
    [P in keyof T]?: NestedPartial<T[P]>
}

export type ConfigOverrides<Config> = NestedPartial<Config>

export type TestContext = {
    diContainer: AwilixContainer
}

export type TestContextFactoryParams<Config> = {
    baseConfigResolver: () => Config
    configDependencyId?: string
}

export class TestContextFactory<Dependencies, ExternalDependencies, Config> {
    private readonly externalDependencies: ExternalDependencies
    private readonly configDependencyId: string;
    private readonly configResolver: () => unknown;

    constructor(externalDependencies: ExternalDependencies, params: TestContextFactoryParams<Config>) {
        this.externalDependencies = externalDependencies;
        this.configResolver = params.baseConfigResolver
        this.configDependencyId = params.configDependencyId ?? 'config'
    }

    resetExternalDependencies() {
        // Override if necessary
    }

    async createTestContext(
        modules: readonly AbstractModule<unknown>[],
        _dependencyOverrides: NameAndRegistrationPair<Dependencies> = {},
        options: DependencyInjectionOptions = {},
        configOverrides?: ConfigOverrides<Config>,
    ) {
        const diContainer = createContainer({
            injectionMode: 'PROXY',
        })

        const context = new DIContext(diContainer, options)

        const dependencyOverrides = configOverrides
            ? ({
                ..._dependencyOverrides,
                [this.configDependencyId]: asSingletonFunction(() => {
                    return merge(this.configResolver(), configOverrides)
                }),
            } as NameAndRegistrationPair<Dependencies>)
            : _dependencyOverrides

        const awilixManager = new AwilixManager({
            diContainer,
            asyncDispose: true,
            asyncInit: true,
            eagerInject: true,
        })

        context.registerDependencies(
            {
                dependencyOverrides,
                modules
            },
            this.externalDependencies,
        )

        await awilixManager.executeInit()

        return {
            diContainer,
            awilixManager,
        }
    }
}

export async function destroyTestContext(testContext: TestContext) {
    await testContext.diContainer.cradle.awilixManager.executeDispose()
    await testContext.diContainer.dispose()
}
