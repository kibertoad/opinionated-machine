import { describe, expectTypeOf, it } from 'vitest'
import type { PublicDependencies } from '../lib/AbstractModule.ts'

// Only import two of the three augmenting modules
import type { EventEmitter, Logger } from './TestCommonModuleAugmented.ts'
import type { UserService } from './TestDomainModuleAugmented.ts'

// TestUnimportedModuleAugmented is NOT imported here at all

describe('Module augmentation is project-wide, not import-scoped', () => {
  it('includes deps from imported augmenting modules', () => {
    expectTypeOf<PublicDependencies>().toHaveProperty('logger')
    expectTypeOf<PublicDependencies['logger']>().toEqualTypeOf<Logger>()

    expectTypeOf<PublicDependencies>().toHaveProperty('eventEmitter')
    expectTypeOf<PublicDependencies['eventEmitter']>().toEqualTypeOf<EventEmitter>()

    expectTypeOf<PublicDependencies>().toHaveProperty('userService')
    expectTypeOf<PublicDependencies['userService']>().toEqualTypeOf<UserService>()
  })

  it('also includes deps from augmenting modules that are NOT imported', () => {
    // TestUnimportedModuleAugmented is never imported in this file,
    // but its `declare module` augmentation applies project-wide
    expectTypeOf<PublicDependencies>().toHaveProperty('billingService')
    expectTypeOf<PublicDependencies>().not.toHaveProperty('nonExistentService')
  })

  it('still omits private deps', () => {
    expectTypeOf<PublicDependencies>().not.toHaveProperty('config')
    expectTypeOf<PublicDependencies>().not.toHaveProperty('userRepository')
  })
})
