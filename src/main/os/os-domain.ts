// What the Settings page may ask about the computer: whether Orivon is its default browser, and to become it. A
// private session changes nothing outside its own directory, so it answers "unavailable" to both.
import type { InternalDomain } from '../pages/internal-ipc.js'
import { makeDefaultBrowser, readDefaultBrowser } from './default-browser.js'
import type { DefaultBrowserHost } from './default-browser.js'

export function osDomain (host: DefaultBrowserHost, isPrivate: boolean, wait: (ms: number) => Promise<void>): InternalDomain {
  return {
    pages: ['settings'],
    handle: async (command) => {
      const type = typeof command === 'object' && command !== null ? (command as { type?: unknown }).type : undefined
      if (type !== 'defaultBrowser' && type !== 'makeDefault') return undefined
      if (isPrivate) return { state: 'unavailable', reason: 'private', ok: false, handedOff: false }
      if (type === 'defaultBrowser') return await readDefaultBrowser(host)
      return await makeDefaultBrowser(host, wait)
    }
  }
}
