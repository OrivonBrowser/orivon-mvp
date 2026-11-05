// What a shell page may ask of the application itself: to start again, so a
// setting that is read at start takes effect. Refused in a private session,
// which cannot be started again (its directory is gone with it).
import type { App } from 'electron'
import { restartOrivon } from '../launch/relaunch.js'
import type { InternalDomain } from './internal-ipc.js'

/** `argv` is the command line this process started with, whose switches (the profile, the data directory) the new one keeps. */
export function appDomain (app: Pick<App, 'relaunch' | 'quit' | 'isPackaged'>, isPrivate: boolean, argv: readonly string[] = process.argv): InternalDomain {
  return {
    pages: ['settings'],
    handle: (command) => {
      const type = typeof command === 'object' && command !== null ? (command as { type?: unknown }).type : undefined
      if (type !== 'relaunch') return undefined
      if (isPrivate) return { ok: false, reason: 'private' }
      restartOrivon(app, argv)
      return { ok: true }
    }
  }
}
