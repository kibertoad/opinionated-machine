import type { DependencyInjectionOptions } from './DIContext.js'

export const ENABLE_ALL = Symbol.for('ENABLE_ALL')

export const resolveJobQueuesEnabled = (
  options: DependencyInjectionOptions,
): boolean | string[] => {
  const { jobQueuesEnabled } = options
  if (!jobQueuesEnabled) {
    return false
  }
  if (jobQueuesEnabled === ENABLE_ALL) {
    return true
  }

  if (Array.isArray(jobQueuesEnabled)) {
    return jobQueuesEnabled.length ? jobQueuesEnabled : false
  }

  return false
}

export const isEnqueuedJobWorkersEnabled = (
  enabled?: false | typeof ENABLE_ALL | string[],
  name?: string,
): boolean => isEnabled(enabled, name)

export const isPeriodicJobEnabled = (
  enabled?: false | typeof ENABLE_ALL | string[],
  name?: string,
): boolean => isEnabled(enabled, name)

export const isJobQueueEnabled = (
  enabled?: false | typeof ENABLE_ALL | string[],
  name?: string,
): boolean => {
  if (!enabled) {
    return false
  }

  if (Array.isArray(enabled) && (!name || enabled.includes(name))) {
    return true
  }

  if (enabled === ENABLE_ALL) {
    return true
  }

  return false
}

export const isMessageQueueConsumerEnabled = (
  messageQueueConsumersEnabled?: false | typeof ENABLE_ALL | string[],
  name?: string,
): boolean => isEnabled(messageQueueConsumersEnabled, name)

export const isAnyMessageQueueConsumerEnabled = (options: DependencyInjectionOptions): boolean =>
  !!options.messageQueueConsumersEnabled

const isEnabled = (
  option: false | typeof ENABLE_ALL | string[] | undefined,
  name?: string,
): boolean => {
  if (!option) {
    return false
  }
  if (name && Array.isArray(option)) {
    return option.includes(name)
  }

  if (option === ENABLE_ALL) {
    return true
  }
  return false
}
