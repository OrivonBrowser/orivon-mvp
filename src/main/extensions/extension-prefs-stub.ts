// The shape of one extension's saved preferences and an in-memory store of
// them. Code in this directory is written against `ExtensionPrefsStore`, so
// the file-backed store and this one are interchangeable; this one is what a
// private runtime and a unit test use.

export interface ExtensionPrefs {
  /** null: follow `extensions.pinNew`. */
  pinned: boolean | null
  granted: { permissions: string[], origins: string[] }
  siteAccess: { mode: 'all' | 'sites' | 'click', sites: string[] }
  /** Command name to binding; '' is a cleared binding. */
  shortcuts: Record<string, string>
  overrides: { newtab: boolean, history: boolean, bookmarks: boolean }
  noticeSeen: string[]
}

export interface ExtensionPrefsStore {
  get: (id: string) => ExtensionPrefs
  update: (id: string, patch: Partial<ExtensionPrefs>) => void
  forget: (id: string) => void
  onChange: (listener: (id: string) => void) => () => void
}

export function defaultExtensionPrefs (): ExtensionPrefs {
  return {
    pinned: null,
    granted: { permissions: [], origins: [] },
    siteAccess: { mode: 'all', sites: [] },
    shortcuts: {},
    overrides: { newtab: true, history: true, bookmarks: true },
    noticeSeen: []
  }
}

export function createMemoryExtensionPrefs (): ExtensionPrefsStore {
  const byId = new Map<string, ExtensionPrefs>()
  const listeners = new Set<(id: string) => void>()
  const notify = (id: string): void => { for (const listener of [...listeners]) listener(id) }
  return {
    get: (id) => structuredClone(byId.get(id) ?? defaultExtensionPrefs()),
    update: (id, patch) => {
      byId.set(id, { ...(byId.get(id) ?? defaultExtensionPrefs()), ...structuredClone(patch) })
      notify(id)
    },
    forget: (id) => {
      if (byId.delete(id)) notify(id)
    },
    onChange: (listener) => {
      listeners.add(listener)
      return () => { listeners.delete(listener) }
    }
  }
}
