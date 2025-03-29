import type { NameAndRegistrationPair } from 'awilix'
import { merge } from 'ts-deepmerge'
import { asSingletonFunction } from './resolverFunctions.js'

export type NestedPartial<T> = {
  [P in keyof T]?: NestedPartial<T[P]>
}

/**
 * Merges incremental changes for config entity with general dependency config overrides
 */
export function mergeConfigAndDependencyOverrides<Dependencies, Config extends object>(
  baseConfig: Config,
  configOverrides?: NestedPartial<Config>,
  dependencyOverrides?: NameAndRegistrationPair<Dependencies>,
) {
  return configOverrides
    ? ({
        ...dependencyOverrides,
        // @ts-expect-error we can't make this type-safe
        [this.configDependencyId]: asSingletonFunction(() => {
          // biome-ignore lint/style/noNonNullAssertion: there is a ternary condition above
          return merge(baseConfig, configOverrides!)
        }),
      } as NameAndRegistrationPair<Dependencies>)
    : dependencyOverrides
}
