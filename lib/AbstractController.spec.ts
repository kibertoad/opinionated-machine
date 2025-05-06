import {
  buildFastifyNoPayloadRoute,
  buildFastifyPayloadRoute,
} from '@lokalise/fastify-api-contracts'
import {
  buildDeleteRoute,
  buildGetRoute,
  buildPayloadRoute,
} from '@lokalise/universal-ts-utils/api-contracts/apiContracts'
import { expectTypeOf } from 'vitest'
import { z } from 'zod'
import type { BuildRoutesReturnType } from '../lib/AbstractController.ts'

describe('AbstractController', () => {
  describe('BuildRoutesReturnType', () => {
    const ITEM_SCHEMA = z.object({
      id: z.string(),
      value: z.string(),
    })

    const _a = buildGetRoute({
      successResponseBodySchema: ITEM_SCHEMA,
      requestPathParamsSchema: ITEM_SCHEMA.pick({ id: true }),
      pathResolver: (pathParams) => `/users/${pathParams.id}`,
    })

    const contracts = {
      getItem: buildGetRoute({
        successResponseBodySchema: ITEM_SCHEMA,
        requestPathParamsSchema: ITEM_SCHEMA.pick({ id: true }),
        pathResolver: (pathParams) => `/users/${pathParams.id}`,
      }),
      deleteItem: buildDeleteRoute({
        successResponseBodySchema: z.undefined(),
        requestPathParamsSchema: ITEM_SCHEMA.pick({ id: true }),
        pathResolver: (pathParams) => `/users/${pathParams.id}`,
      }),
      updateItem: buildPayloadRoute({
        method: 'patch',
        requestBodySchema: ITEM_SCHEMA.pick({ value: true }),
        successResponseBodySchema: z.object({ success: z.boolean() }),
        requestPathParamsSchema: ITEM_SCHEMA.pick({ id: true }),
        pathResolver: (pathParams) => `/users/${pathParams.id}`,
      }),
    } as const

    const getItem = buildFastifyNoPayloadRoute(contracts.getItem, async (_, reply) =>
      reply.status(200).send({
        id: '1',
        value: 'test',
      }),
    )

    const deleteItem = buildFastifyNoPayloadRoute(contracts.deleteItem, async (_, reply) =>
      reply.status(200).send(),
    )

    const updateItem = buildFastifyPayloadRoute(contracts.updateItem, async (_, reply) =>
      reply.status(200).send({ success: true }),
    )

    it('should narrow down type correctly', () => {
      type ExpectedType = BuildRoutesReturnType<typeof contracts>

      const validRoutes1 = {
        getItem,
        deleteItem,
        updateItem,
      }
      expectTypeOf(validRoutes1).toExtend<ExpectedType>()

      const validRoutes2 = {
        getItem,
        deleteItem,
        updateItem,
        extraRoute: {} as unknown,
      }
      expectTypeOf(validRoutes2).toExtend<ExpectedType>()

      const usingGetInDelete = {
        getItem,
        deleteItem: getItem,
        updateItem,
      }
      expectTypeOf(usingGetInDelete).not.toExtend<ExpectedType>()

      const usingGetInUpdate = {
        getItem,
        deleteItem,
        updateItem: getItem,
      }
      expectTypeOf(usingGetInUpdate).not.toExtend<ExpectedType>()

      const usingDeleteInGet = {
        getItem: deleteItem,
        deleteItem,
        updateItem,
      }
      expectTypeOf(usingDeleteInGet).not.toExtend<ExpectedType>()

      const usingDeleteInUpdate = {
        getItem,
        deleteItem,
        updateItem: deleteItem,
      }
      expectTypeOf(usingDeleteInUpdate).not.toExtend<ExpectedType>()

      const usingUpdateInGet = {
        getItem: updateItem,
        deleteItem,
        updateItem,
      }
      expectTypeOf(usingUpdateInGet).not.toExtend<ExpectedType>()

      const usingUpdateInDelete = {
        getItem,
        deleteItem: updateItem,
        updateItem,
      }
      expectTypeOf(usingUpdateInDelete).not.toExtend<ExpectedType>()
    })
  })
})
