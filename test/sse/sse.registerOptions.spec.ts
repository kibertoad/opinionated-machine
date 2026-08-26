import FastifySSEPlugin from '@fastify/sse'
import { buildSseContract } from '@lokalise/api-contracts'
import { createContainer } from 'awilix'
import fastify, { type FastifyInstance, type RouteOptions } from 'fastify'
import { serializerCompiler, validatorCompiler } from 'fastify-type-provider-zod'
import { describe, expect, it } from 'vitest'
import { z } from 'zod'
import {
  AbstractModule,
  AbstractSSEController,
  asSSEControllerClass,
  type BuildFastifySSERoutesReturnType,
  buildHandler,
  type DependencyInjectionOptions,
  DIContext,
  type MandatoryNameAndRegistrationPair,
  type RegisterSSERoutesOptions,
} from '../../index.js'

/**
 * `@fastify/sse` reads per-route configuration from the top-level `sse` route option,
 * so registration-level defaults have to land there (and not, say, on `config.sse`,
 * which the plugin never looks at).
 */

const plainContract = buildSseContract({
  visibility: 'public',
  method: 'get',
  pathResolver: () => '/api/register-options/plain',
  requestPathParamsSchema: z.object({}),
  requestQuerySchema: z.object({}),
  requestHeaderSchema: z.object({}),
  serverSentEventSchemas: { message: z.object({ text: z.string() }) },
})

const configuredContract = buildSseContract({
  visibility: 'public',
  method: 'get',
  pathResolver: () => '/api/register-options/configured',
  requestPathParamsSchema: z.object({}),
  requestQuerySchema: z.object({}),
  requestHeaderSchema: z.object({}),
  serverSentEventSchemas: { message: z.object({ text: z.string() }) },
})

const routeSerializer = (data: unknown) => `route:${JSON.stringify(data)}`
const globalSerializer = (data: unknown) => `global:${JSON.stringify(data)}`

type RegisterOptionsContracts = {
  plain: typeof plainContract
  configured: typeof configuredContract
}

class RegisterOptionsSSEController extends AbstractSSEController<RegisterOptionsContracts> {
  public static contracts = { plain: plainContract, configured: configuredContract } as const

  buildSSERoutes(): BuildFastifySSERoutesReturnType<RegisterOptionsContracts> {
    return { plain: this.handlePlain, configured: this.handleConfigured }
  }

  private handlePlain = buildHandler(plainContract, {
    sse: (_request, sse) => {
      sse.start('keepAlive')
    },
  })

  private handleConfigured = buildHandler(
    configuredContract,
    {
      sse: (_request, sse) => {
        sse.start('keepAlive')
      },
    },
    { heartbeat: false, serializer: routeSerializer },
  )
}

class RegisterOptionsSSEModule extends AbstractModule<object> {
  resolveDependencies(): MandatoryNameAndRegistrationPair<object> {
    return {}
  }

  override resolveControllers(
    diOptions: DependencyInjectionOptions,
  ): MandatoryNameAndRegistrationPair<unknown> {
    return {
      registerOptionsSSEController: asSSEControllerClass(RegisterOptionsSSEController, {
        diOptions,
      }),
    }
  }
}

async function collectRoutes(
  registerOptions?: RegisterSSERoutesOptions,
): Promise<Map<string, RouteOptions>> {
  const app: FastifyInstance = fastify()
  await app.register(FastifySSEPlugin as unknown as Parameters<typeof app.register>[0], {})
  app.setValidatorCompiler(validatorCompiler)
  app.setSerializerCompiler(serializerCompiler)

  const routes = new Map<string, RouteOptions>()
  app.addHook('onRoute', (routeOptions) => {
    routes.set(routeOptions.url, routeOptions as unknown as RouteOptions)
  })

  const container = createContainer<object>({ injectionMode: 'PROXY' })
  const context = new DIContext<object, object>(container, {}, {})
  context.registerDependencies({ modules: [new RegisterOptionsSSEModule()] }, undefined)
  context.registerSSERoutes(app, registerOptions)

  await app.ready()
  await app.close()
  await context.destroy()

  return routes
}

describe('registerSSERoutes SSE options', () => {
  it('leaves the sse route option untouched when no SSE defaults are given', async () => {
    const routes = await collectRoutes()

    expect(routes.get('/api/register-options/plain')?.sse).toBe(true)
    expect(routes.get('/api/register-options/configured')?.sse).toEqual({
      heartbeat: false,
      serializer: routeSerializer,
    })
  })

  it('applies registration-level defaults to the sse route option', async () => {
    const routes = await collectRoutes({ heartbeat: false, serializer: globalSerializer })

    expect(routes.get('/api/register-options/plain')?.sse).toEqual({
      heartbeat: false,
      serializer: globalSerializer,
    })
  })

  it('lets per-route values win over registration-level defaults', async () => {
    const routes = await collectRoutes({ heartbeat: true, serializer: globalSerializer })

    expect(routes.get('/api/register-options/configured')?.sse).toEqual({
      heartbeat: false,
      serializer: routeSerializer,
    })
  })
})
