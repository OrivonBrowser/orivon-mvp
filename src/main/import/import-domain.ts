// What the Import page may ask: which profiles of other browsers there are, to import one, to import a
// bookmarks file the person picks, and to open the bookmark manager. A profile is named by its place in the
// last answer to `detect` and a file is never named at all: no path crosses this boundary in either
// direction. A private window reads nothing and answers every request the same way.
import type { WebContents } from 'electron'
import type { InternalDomain } from '../pages/internal-ipc.js'
import { BROWSER_NAMES } from './import-types.js'
import type { BrowserKey, ImportResult, ImportSource } from './import-types.js'
import type { ImportWhat } from './import-runner.js'

/** What the domain needs from this process and this machine. */
export interface ImportHost {
  readonly isPrivate: boolean
  detect: () => Promise<ImportSource[]>
  historyOn: () => boolean
  /** Whether the bookmark manager exists to be opened. */
  managerAvailable: () => boolean
  run: (source: ImportSource, what: ImportWhat) => Promise<ImportResult>
  /** Asks the person for a bookmarks file over the window holding `contents`; `undefined` when they cancel. */
  runFile: (contents: WebContents) => Promise<ImportResult | undefined>
  openManager: (contents: WebContents) => void
}

interface ImportRequest {
  readonly type?: unknown
  readonly id?: unknown
  readonly bookmarks?: unknown
  readonly history?: unknown
  readonly target?: unknown
}

export interface ListedSource {
  readonly id: string
  readonly key: BrowserKey
  readonly browser: string
  readonly profile: string
}

export function importDomain (host: ImportHost): InternalDomain {
  let sources: readonly ImportSource[] = []
  let running = false
  return {
    pages: ['import'],
    handle: async (command, caller) => {
      if (host.isPrivate) return { private: true }
      const request = (typeof command === 'object' && command !== null ? command : {}) as ImportRequest
      switch (request.type) {
        case 'detect': {
          sources = await host.detect()
          const listed: ListedSource[] = sources.map((source, index) => ({ id: String(index), key: source.browser, browser: BROWSER_NAMES[source.browser], profile: source.profile }))
          return { private: false, sources: listed, historyOn: host.historyOn(), manager: host.managerAvailable() }
        }
        case 'run': {
          const source = typeof request.id === 'string' && /^\d{1,4}$/.test(request.id) ? sources[Number(request.id)] : undefined
          if (source === undefined || typeof request.bookmarks !== 'boolean' || typeof request.history !== 'boolean') return undefined
          const what = { bookmarks: request.bookmarks, history: request.history && host.historyOn() }
          if (!what.bookmarks && !what.history) return undefined
          if (running) return { busy: true }
          running = true
          try {
            return { result: await host.run(source, what) }
          } finally {
            running = false
          }
        }
        case 'runHtml': {
          if (running) return { busy: true }
          running = true
          try {
            const result = await host.runFile(caller.contents)
            return result === undefined ? { cancelled: true } : { result }
          } finally {
            running = false
          }
        }
        case 'open':
          if (request.target !== 'bookmarks' || !host.managerAvailable()) return undefined
          host.openManager(caller.contents)
          return { ok: true }
        default:
          return undefined
      }
    }
  }
}
