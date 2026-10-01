import type { Crx } from './crx.js'

/** `chrome.permissions` with the calls made strict, so a refusal rejects with its own message, and `request` told whether the page has a user gesture (a worker never does). */
export function permissionsApi (): void {
  const crx = (globalThis as unknown as { __crx: Crx }).__crx
  crx.define('permissions', (base) => {
    const askMain = crx.call('permissions.request')
    return {
      ...base,
      contains: crx.call('permissions.contains'),
      getAll: crx.call('permissions.getAll'),
      remove: crx.call('permissions.remove'),
      addHostAccessRequest: crx.call('permissions.addHostAccessRequest'),
      removeHostAccessRequest: crx.call('permissions.removeHostAccessRequest'),
      request: (...args: unknown[]) => {
        const callback = typeof args[args.length - 1] === 'function' ? args.pop() : undefined
        const gesture = typeof navigator !== 'undefined' &&
          (navigator as unknown as { userActivation?: { isActive?: boolean } }).userActivation?.isActive === true
        return askMain(args[0], gesture, ...(callback === undefined ? [] : [callback]))
      },
      onAdded: crx.event('permissions.onAdded'),
      onRemoved: crx.event('permissions.onRemoved')
    }
  })
}
