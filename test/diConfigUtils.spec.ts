import { describe, expect, it } from 'vitest'
import {
  ENABLE_ALL,
  isJobWorkersEnabled,
  isMessageQueueConsumerEnabled,
  resolveJobQueuesEnabled,
} from '../lib/diConfigUtils.js'

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
      expect(isJobWorkersEnabled(ENABLE_ALL)).toBeTruthy()
    })

    it('returns false when isJobWorkersEnabled is false', () => {
      expect(isJobWorkersEnabled(false)).toBeFalsy()
    })

    it('returns false when isJobWorkersEnabled is undefined', () => {
      expect(isJobWorkersEnabled()).toBeFalsy()
    })

    it('returns false when isJobWorkersEnabled is an array that includes the queue name', () => {
      expect(isJobWorkersEnabled(['e1', 'e2'], 'e1')).toBeTruthy()
    })

    it('returns false when isJobWorkersEnabled is an array that does not include the queue name', () => {
      expect(isJobWorkersEnabled(['e1', 'e2'], 'e3')).toBeFalsy()
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
})
