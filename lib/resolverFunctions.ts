import { asClass } from 'awilix'
import type { BuildResolver, BuildResolverOptions, Constructor, DisposableResolver } from 'awilix'

declare module 'awilix' {
  // biome-ignore lint/correctness/noUnusedVariables: interface overrides must match exactly
  interface ResolverOptions<T> {
    entityType:
      | 'controller'
      | 'useCase'
      | 'service'
      | 'repository'
      | 'jobConsumer'
      | 'queueConsumer'
      | 'expendable'
      | 'infrastructure'
  }
}

export function asControllerClass<T = object>(
  Type: Constructor<T>,
  opts?: BuildResolverOptions<T>,
): BuildResolver<T> & DisposableResolver<T> {
  return asClass(Type, {
    ...opts,
    lifetime: 'SINGLETON',
    entityType: 'controller',
  })
}
