// What a shell page may ask of the application itself: to start again, so a
// setting that is read at start takes effect. Refused in a private session,
// which cannot be started again (its directory is gone with it).
import type { App } from 'electron'
import { withoutAddresses } from '../launch/launch-context.js'
import type { InternalDomain } from './internal-ipc.js'

/** `argv` is the command line this process started with, whose switches (the profile, the data directory) the new one keeps. */
export function appDomain (app: Pick<App, 'relaunch' | 'quit' | 'isPackaged'>, isPrivate: boolean, argv: readonly string[] = process.argv): InternalDomain {
  return {
    pages: ['settings'],
    handle: (command) => {
      const type = typeof command === 'object' && command !== null ? (command as { type?: unknown }).type : undefined
      if (type !== 'relaunch') return undefined
      if (isPrivate) return { ok: false, reason: 'private' }
      // `quit`, never `exit`: the stores flush before the browser closes.
      // Without the addresses and files it was started with: the page launched from another program is not opened again.
      app.relaunch({ args: withoutAddresses(argv.slice(1), app.isPackaged) })
      app.quit()
      return { ok: true }
    }
  }
}
