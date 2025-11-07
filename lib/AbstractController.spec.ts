import { buildDeleteRoute, buildGetRoute, buildPayloadRoute } from '@lokalise/api-contracts'
import {
  buildFastifyNoPayloadRoute,
  buildFastifyPayloadRoute,
} from '@lokalise/fastify-api-contracts'
import { expectTypeOf } from 'vitest'
import { z } from 'zod/v4'
import type { BuildRoutesReturnType } from '../lib/AbstractController.js'

describe('AbstractController', () => {
  describe('BuildRoutesReturnType', () => {
    const ITEM_SCHEMA = z.object({
      id: z.string(),
      value: z.string(),
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
        successResponseBodySchema: z.undefined(),
        isEmptyResponseExpected: true,
        isNonJSONResponseExpected: true,
        requestPathParamsSchema: ITEM_SCHEMA.pick({ id: true }),
        pathResolver: (pathParams) => `/users/${pathParams.id}`,
      }),
      createItem: buildPayloadRoute({
        method: 'post',
        requestBodySchema: ITEM_SCHEMA.pick({ value: true }),
        successResponseBodySchema: z.object({ success: z.boolean() }),
        pathResolver: () => '/users',
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
      reply.status(200).send(),
    )

    const createItem = buildFastifyPayloadRoute(contracts.createItem, async (_, reply) =>
      reply.status(200).send({ success: true }),
    )

    it('should narrow down type correctly', () => {
      type ExpectedType = BuildRoutesReturnType<typeof contracts>

      const validRoutes1 = {
        getItem,
        deleteItem,
        updateItem,
        createItem,
      }
      expectTypeOf(validRoutes1).toExtend<ExpectedType>()

      const validRoutes2 = {
        getItem,
        deleteItem,
        updateItem,
        createItem,
        extraRoute: {} as unknown,
      }
      expectTypeOf(validRoutes2).toExtend<ExpectedType>()

      const usingGetInDelete = {
        getItem,
        deleteItem: getItem,
        updateItem,
        createItem,
      }
      expectTypeOf(usingGetInDelete).not.toExtend<ExpectedType>()

      const usingGetInUpdate = {
        getItem,
        deleteItem,
        updateItem: getItem,
        createItem,
      }
      expectTypeOf(usingGetInUpdate).not.toExtend<ExpectedType>()

      const usingGetInCreate = {
        getItem,
        deleteItem,
        updateItem,
        createItem: getItem,
      }
      expectTypeOf(usingGetInCreate).not.toExtend<ExpectedType>()

      const usingDeleteInGet = {
        getItem: deleteItem,
        deleteItem,
        updateItem,
        createItem,
      }
      expectTypeOf(usingDeleteInGet).not.toExtend<ExpectedType>()

      const usingDeleteInUpdate = {
        getItem,
        deleteItem,
        updateItem: deleteItem,
        createItem,
      }
      expectTypeOf(usingDeleteInUpdate).not.toExtend<ExpectedType>()

      const usingDeleteInCreate = {
        getItem,
        deleteItem,
        updateItem,
        createItem: deleteItem,
      }
      expectTypeOf(usingDeleteInCreate).not.toExtend<ExpectedType>()

      const usingUpdateInGet = {
        getItem: updateItem,
        deleteItem,
        updateItem,
        createItem,
      }
      expectTypeOf(usingUpdateInGet).not.toExtend<ExpectedType>()

      const usingUpdateInDelete = {
        getItem,
        deleteItem: updateItem,
        updateItem,
        createItem,
      }
      expectTypeOf(usingUpdateInDelete).not.toExtend<ExpectedType>()

      const usingUpdateInCreate = {
        getItem,
        deleteItem,
        updateItem,
        createItem: updateItem,
      }
      expectTypeOf(usingUpdateInCreate).not.toExtend<ExpectedType>()

      const usingCreateInGet = {
        getItem: createItem,
        deleteItem,
        updateItem,
        createItem,
      }
      expectTypeOf(usingCreateInGet).not.toExtend<ExpectedType>()

      const usingCreateInDelete = {
        getItem,
        deleteItem: createItem,
        updateItem,
        createItem,
      }
      expectTypeOf(usingCreateInDelete).not.toExtend<ExpectedType>()

      const usingCreateInUpdate = {
        getItem,
        deleteItem,
        updateItem: createItem,
        createItem,
      }
      expectTypeOf(usingCreateInUpdate).not.toExtend<ExpectedType>()
    })
  })
})
