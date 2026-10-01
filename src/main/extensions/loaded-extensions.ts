// How many extensions are loaded into the session extensions run in, and when
// that changes: what the toolbar's Extensions button follows. Read from the
// session, not the registry file, so a push never touches a disk.
import type { Session } from 'electron'

export interface LoadedExtensions {
  count: () => number
  /** Calls `listener` whenever an extension loads or unloads (installing, enabling, disabling, removing, reloading). Returns the removal. */
  onChange: (listener: () => void) => () => void
}

export function createLoadedExtensions (session: Pick<Session, 'extensions'>): LoadedExtensions {
  return {
    count: () => session.extensions.getAllExtensions().length,
    onChange: (listener) => {
      const notify = (): void => { listener() }
      session.extensions.on('extension-loaded', notify)
      session.extensions.on('extension-unloaded', notify)
      return () => {
        session.extensions.off('extension-loaded', notify)
        session.extensions.off('extension-unloaded', notify)
      }
    }
  }
}
