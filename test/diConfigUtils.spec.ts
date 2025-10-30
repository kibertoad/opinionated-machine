import { describe, expect, it } from 'vitest'
import {
  ENABLE_ALL,
  isAnyMessageQueueConsumerEnabled,
  isEnqueuedJobWorkersEnabled,
  isMessageQueueConsumerEnabled,
  isPeriodicJobEnabled,
  resolveJobQueuesEnabled,
} from '../lib/diConfigUtils.ts'

describe('diConfigUtils', () => {
  describe('resolveJobQueuesEnabled', () => {
    it('returns true when jobQueuesEnabled is ENABLE_ALL', () => {
      expect(resolveJobQueuesEnabled({ jobQueuesEnabled: ENABLE_ALL })).toBeTruthy()
    })

    it('returns false when jobQueuesEnabled is false', () => {
      expect(resolveJobQueuesEnabled({ jobQueuesEnabled: false })).toBeFalsy()
    })

    it('returns false when jobQueuesEnabled is undefined', () => {
      expect(resolveJobQueuesEnabled({})).toBeFalsy()
    })

    it('returns false when jobQueuesEnabled is an empty array', () => {
      expect(resolveJobQueuesEnabled({ jobQueuesEnabled: [] })).toBeFalsy()
    })

    it('returns array when jobQueuesEnabled is a valid array', () => {
      expect(resolveJobQueuesEnabled({ jobQueuesEnabled: ['e1', 'e2'] })).toEqual(['e1', 'e2'])
    })
  })

  describe('isJobWorkersEnabled', () => {
    it('returns true when isJobWorkersEnabled is ENABLE_ALL', () => {
      expect(isEnqueuedJobWorkersEnabled(ENABLE_ALL)).toBeTruthy()
    })

    it('returns false when isJobWorkersEnabled is false', () => {
      expect(isEnqueuedJobWorkersEnabled(false)).toBeFalsy()
    })

    it('returns false when isJobWorkersEnabled is undefined', () => {
      expect(isEnqueuedJobWorkersEnabled()).toBeFalsy()
    })

    it('returns false when isJobWorkersEnabled is an array that includes the queue name', () => {
      expect(isEnqueuedJobWorkersEnabled(['e1', 'e2'], 'e1')).toBeTruthy()
    })

    it('returns false when isJobWorkersEnabled is an array that does not include the queue name', () => {
      expect(isEnqueuedJobWorkersEnabled(['e1', 'e2'], 'e3')).toBeFalsy()
    })
  })

  describe('isPeriodicJobEnabled', () => {
    it('returns true when isPeriodicJobEnabled is ENABLE_ALL', () => {
      expect(isPeriodicJobEnabled(ENABLE_ALL)).toBeTruthy()
    })

    it('returns false when isPeriodicJobEnabled is false', () => {
      expect(isPeriodicJobEnabled(false)).toBeFalsy()
    })

    it('returns false when isPeriodicJobEnabled is undefined', () => {
      expect(isPeriodicJobEnabled()).toBeFalsy()
    })

    it('returns false when isPeriodicJobEnabled is an array that includes the queue name', () => {
      expect(isPeriodicJobEnabled(['e1', 'e2'], 'e1')).toBeTruthy()
    })

    it('returns false when isPeriodicJobEnabled is an array that does not include the queue name', () => {
      expect(isPeriodicJobEnabled(['e1', 'e2'], 'e3')).toBeFalsy()
    })
  })

  describe('isMessageQueueConsumerEnabled', () => {
    it('returns true when isMessageQueueConsumerEnabled is true', () => {
      expect(isMessageQueueConsumerEnabled(ENABLE_ALL)).toBeTruthy()
    })

    it('returns false when isMessageQueueConsumerEnabled is false', () => {
      expect(isMessageQueueConsumerEnabled(false)).toBeFalsy()
    })

    it('returns false when isMessageQueueConsumerEnabled is undefined', () => {
      expect(isMessageQueueConsumerEnabled()).toBeFalsy()
    })

    it('returns true when isMessageQueueConsumerEnabled is an array that includes the job name', () => {
      expect(isMessageQueueConsumerEnabled(['e1', 'e2'], 'e1')).toBeTruthy()
    })

    it('returns false when isMessageQueueConsumerEnabled is an array that does not include the job name', () => {
      expect(isMessageQueueConsumerEnabled(['e1', 'e2'], 'e3')).toBeFalsy()
    })
  })
  describe('isAnyMessageQueueConsumerEnabled', () => {
    it('returns true when isMessageQueueConsumerEnabled is true', () => {
      expect(
        isAnyMessageQueueConsumerEnabled({ messageQueueConsumersEnabled: ENABLE_ALL }),
      ).toBeTruthy()
    })

    it('returns false when isMessageQueueConsumerEnabled is false', () => {
      expect(isAnyMessageQueueConsumerEnabled({ messageQueueConsumersEnabled: false })).toBeFalsy()
    })

    it('returns false when isMessageQueueConsumerEnabled is undefined', () => {
      expect(isAnyMessageQueueConsumerEnabled({})).toBeFalsy()
    })

    it('returns true when isMessageQueueConsumerEnabled is an array', () => {
      expect(
        isAnyMessageQueueConsumerEnabled({ messageQueueConsumersEnabled: ['e1', 'e2'] }),
      ).toBeTruthy()
    })
  })
})
