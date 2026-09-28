// What a shell page may ask of the application itself: to start again, so a
// setting that is read at start takes effect. Refused in a private session,
// which cannot be started again (its directory is gone with it).
import type { App } from 'electron'
import type { InternalDomain } from './internal-ipc.js'

export function appDomain (app: Pick<App, 'relaunch' | 'quit'>, isPrivate: boolean): InternalDomain {
  return {
    pages: ['settings'],
    handle: (command) => {
      const type = typeof command === 'object' && command !== null ? (command as { type?: unknown }).type : undefined
      if (type !== 'relaunch') return undefined
      if (isPrivate) return { ok: false, reason: 'private' }
      // `quit`, never `exit`: the stores flush before the browser closes.
      app.relaunch()
      app.quit()
      return { ok: true }
    }
  }
}
