// `timers` module target (module-map.ts): the page's own timer functions,
// read at call time so the preload-installed setImmediate is found even when
// this module loads first. `promises` is timers/promises.

import { nodeModule } from './module-proxy.js'
import promises from './timers-promises.js'

type TimerName = 'setTimeout' | 'clearTimeout' | 'setInterval' | 'clearInterval' | 'setImmediate' | 'clearImmediate'

function current<Name extends TimerName> (name: Name): (typeof globalThis)[Name] {
  const forward = (...args: unknown[]): unknown => (globalThis[name] as (...forwarded: unknown[]) => unknown)(...args)
  return forward as unknown as (typeof globalThis)[Name]
}

export const setTimeout = current('setTimeout')
export const clearTimeout = current('clearTimeout')
export const setInterval = current('setInterval')
export const clearInterval = current('clearInterval')
export const setImmediate = current('setImmediate')
export const clearImmediate = current('clearImmediate')
export { promises }

export default nodeModule('timers', { setTimeout, clearTimeout, setInterval, clearInterval, setImmediate, clearImmediate, promises })
