import type { DependencyInjectionOptions } from './DIContext.js'

export const resolveEnqueuedJobQueuesEnabled = (
  options: DependencyInjectionOptions,
): boolean | string[] => {
  const { enqueuedJobQueuesEnabled } = options
  if (!enqueuedJobQueuesEnabled) return false
  if (Array.isArray(enqueuedJobQueuesEnabled)) {
    return enqueuedJobQueuesEnabled.length ? enqueuedJobQueuesEnabled : false
  }

  return enqueuedJobQueuesEnabled
}

export const isEnqueuedJobProcessorEnabled = (
  options: DependencyInjectionOptions,
  name?: string,
): boolean => isEnabled(options.enqueuedJobProcessorsEnabled, name)

export const isEnqueuedJobQueueEnabled = (
  options: DependencyInjectionOptions,
  name?: string,
): boolean => isEnabled(options.enqueuedJobQueuesEnabled, name)

export const isMessageQueueConsumerEnabled = (
  options: DependencyInjectionOptions,
  name?: string,
): boolean => isEnabled(options.messageQueueConsumersEnabled, name)

const isEnabled = (option: boolean | string[] | undefined, name?: string): boolean => {
  return name && Array.isArray(option) ? option.includes(name) : !!option
}
