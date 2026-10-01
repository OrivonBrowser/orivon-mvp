import type { Crx } from './crx.js'

/**
 * `chrome.runtime` additions over Electron's own object.
 *
 * `getManifest` answers with the `declarative_net_request` the extension
 * shipped: the loaded copy has it moved to `x_orivon_declarative_net_request`
 * (extension-manifest.ts's `LOADED_DNR_KEY`) because Orivon runs those rules,
 * and a blocker reads its ruleset list from its own manifest to start up.
 *
 * `onInstalled` (a service worker only): Electron's own event never fires, so
 * a worker asks main once as it starts whether it was just installed or
 * updated and fires its listeners with the answer: the details reach every
 * listener present when they arrive, and any added within the next 3 seconds
 * (a module worker adds its listeners after its imports have loaded).
 */
export function runtimeApi (): void {
  const crx = (globalThis as unknown as { __crx: Crx }).__crx
  const isWorker = crx.context === 'worker'
  const listeners: Array<(details: unknown) => void> = []
  let details: unknown
  let arrivedAt = 0
  const fresh = (): boolean => details !== undefined && Date.now() - arrivedAt < 3000
  const onInstalled = {
    addListener (callback: (details: unknown) => void): void {
      if (typeof callback !== 'function' || listeners.includes(callback)) return
      listeners.push(callback)
      if (fresh()) queueMicrotask(() => { callback(details) })
    },
    removeListener (callback: (details: unknown) => void): void {
      const index = listeners.indexOf(callback)
      if (index !== -1) listeners.splice(index, 1)
    },
    hasListener: (callback: (details: unknown) => void): boolean => listeners.includes(callback),
    hasListeners: (): boolean => listeners.length > 0
  }
  crx.define('runtime', (base) => ({
    ...base,
    getManifest: (): unknown => {
      const loaded = typeof base?.getManifest === 'function' ? base.getManifest() : undefined
      if (loaded === null || typeof loaded !== 'object' || !('x_orivon_declarative_net_request' in loaded)) return loaded
      const { x_orivon_declarative_net_request: shipped, ...rest } = loaded as Record<string, unknown>
      return { ...rest, declarative_net_request: shipped }
    },
    ...(isWorker ? { onInstalled } : {})
  }))
  if (!isWorker) return
  crx.call('runtime.takeInstalled')().then((answer) => {
    if (answer === null || answer === undefined) return
    details = answer
    arrivedAt = Date.now()
    for (const callback of listeners.slice()) queueMicrotask(() => { callback(details) })
  }, () => {})
}
