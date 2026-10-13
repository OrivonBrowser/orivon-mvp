// The person's extensions in one profile session (`../route/site-partition.ts`): the extensions loaded in the default
// session are loaded in the profile session too, once, and follow the default session's loading and unloading while they
// are on, so a hundred websites in a profile cost one copy of each extension and not a hundred.
//
// The copies are on or off as a whole. The tunnel profile's stay on once its first website has asked for them. The direct
// profile's are on only while one of the websites the person left out of the tunnel is open there (`profile-demand.ts`): off,
// no extension of theirs has a page, a worker or a request in that session. Tied to Electron.
import type { Extension, LoadExtensionOptions } from 'electron'

/** What this needs of a session's `extensions`: Electron's own, narrowed so that a test can supply a fake. */
export interface SessionExtensions {
  readonly getAllExtensions: () => Extension[]
  readonly loadExtension: (path: string, options?: LoadExtensionOptions) => Promise<Extension>
  readonly removeExtension: (id: string) => void
  readonly getExtension: (id: string) => Extension | null
  on (event: 'extension-loaded', listener: (event: unknown, extension: Extension) => void): unknown
  on (event: 'extension-unloaded', listener: (event: unknown, extension: Extension) => void): unknown
}

export interface ProfileExtensions {
  /** Loads the extensions of the source session, and keeps them in step with it, until `deactivate`. Settles once they are loaded; never throws. */
  readonly activate: () => Promise<void>
  /** Stops following the source and removes every extension from the profile session; settles once they are gone. */
  readonly deactivate: () => Promise<void>
  readonly isActive: () => boolean
  /** On, and nothing left to load or remove. */
  readonly isReady: () => boolean
  /** The ids loaded in the profile session now. */
  readonly loaded: () => readonly string[]
}

/** Mirrors `source`'s extensions into `target`. Nothing is loaded until the first `activate`. */
export function createProfileExtensions (target: SessionExtensions, source: SessionExtensions): ProfileExtensions {
  const loaded = new Set<string>()
  let wanted = false
  /** Every load and removal runs after the one before it, so a removal never meets a load still in flight. */
  let queue: Promise<void> = Promise.resolve()
  let queued = 0
  const enqueue = (run: () => Promise<void> | void): Promise<void> => {
    queued++
    queue = queue.then(run).catch((error: unknown) => { console.error(`[extensions] a profile session's extensions could not be updated: ${String(error)}`) }).finally(() => { queued-- })
    return queue
  }

  const remove = (id: string): void => {
    loaded.delete(id)
    try {
      if (target.getExtension(id) !== null) target.removeExtension(id)
    } catch (error) {
      console.error(`[extensions] could not remove ${id} from a profile session: ${String(error)}`)
    }
  }

  const load = async (extension: Extension): Promise<void> => {
    if (!wanted || loaded.has(extension.id)) return
    try {
      // Never allowFileAccess: true -- extensions never get file:// access (README.md's Design notes).
      await target.loadExtension(extension.path, { allowFileAccess: false })
      loaded.add(extension.id)
    } catch (error) {
      console.error(`[extensions] could not load ${extension.name} into a profile session: ${String(error)}`)
    }
  }

  // An extension that loads into the profile session by another way (the service-worker recovery reloads one in place) is held to
  // the same switch: it stays only while the copies are on, and then counts among them, so that switching off removes it.
  target.on('extension-loaded', (_event, extension) => {
    if (wanted) loaded.add(extension.id)
    else remove(extension.id)
  })
  // orivon:floating-ok -- `enqueue` catches everything its task can throw
  source.on('extension-loaded', (_event, extension) => { void enqueue(async () => { await load(extension) }) })
  // orivon:floating-ok -- `enqueue` catches everything its task can throw
  source.on('extension-unloaded', (_event, extension) => { void enqueue(() => { remove(extension.id) }) })

  return {
    activate: async () => {
      wanted = true
      await enqueue(async () => {
        for (const extension of source.getAllExtensions()) await load(extension)
      })
    },
    deactivate: async () => {
      wanted = false
      await enqueue(() => { for (const id of [...loaded]) remove(id) })
    },
    isActive: () => wanted,
    isReady: () => wanted && queued === 0,
    loaded: () => [...loaded]
  }
}
