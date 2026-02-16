import { describe, expectTypeOf, it } from 'vitest'
import type { PublicDependencies } from '../lib/AbstractModule.ts'

// Only import two of the three augmenting modules
import type { EventEmitter, Logger } from './TestCommonModuleAugmented.ts'
import type { UserService } from './TestDomainModuleAugmented.ts'

// TestUnimportedModuleAugmented is deliberately NOT imported

describe('Module augmentation: PublicDependencies from library interface', () => {
  it('includes public deps from TestCommonModuleAugmented', () => {
    expectTypeOf<PublicDependencies>().toHaveProperty('logger')
    expectTypeOf<PublicDependencies['logger']>().toEqualTypeOf<Logger>()

    expectTypeOf<PublicDependencies>().toHaveProperty('eventEmitter')
    expectTypeOf<PublicDependencies['eventEmitter']>().toEqualTypeOf<EventEmitter>()
  })

  it('includes public deps from TestDomainModuleAugmented', () => {
    expectTypeOf<PublicDependencies>().toHaveProperty('userService')
    expectTypeOf<PublicDependencies['userService']>().toEqualTypeOf<UserService>()
  })

  it('includes public deps from TestUnimportedModuleAugmented despite no import', () => {
    // TestUnimportedModuleAugmented is never imported in this file,
    // but its `declare module` augmentation applies project-wide
    expectTypeOf<PublicDependencies>().toHaveProperty('billingService')
    expectTypeOf<PublicDependencies>().not.toHaveProperty('nonExistentService')
  })

  it('omits private deps from all modules', () => {
    expectTypeOf<PublicDependencies>().not.toHaveProperty('config')
    expectTypeOf<PublicDependencies>().not.toHaveProperty('userRepository')
  })
})
