// A plain, Electron-free "something about this origin's grants changed"
// signal -- src/broker/ must never import Electron (README.md), so the push
// to a live Settings page has to start as a listener set here, not an event
// emitter borrowed from Node or Electron. `../../index.ts` is the only
// caller that emits: the four functions that actually mutate the ledger or
// the picked-path ledger (grant/revoke/revokePersisted/
// revokeUserSelectedPath) are the one door every surface already grants and
// revokes through (this file's own header on why that door exists), so
// hooking those four is the whole mechanism -- no other file needs to know
// this exists.

export type GrantsChangeListener = (origin: string) => void

export interface GrantsChangeEmitter {
  /** Returns the unsubscribe. */
  onChange: (listener: GrantsChangeListener) => () => void
  emit: (origin: string) => void
}

export function createGrantsChangeEmitter (): GrantsChangeEmitter {
  const listeners = new Set<GrantsChangeListener>()
  return {
    onChange (listener) {
      listeners.add(listener)
      return () => { listeners.delete(listener) }
    },
    emit (origin) {
      for (const listener of listeners) listener(origin)
    }
  }
}
