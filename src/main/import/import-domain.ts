// What the Import page may ask: which profiles of other browsers there are, to import one, to import a
// bookmarks file the person picks, and to open the bookmark manager. A profile is named by an id made from the
// profile itself and a secret of this run, so a second Import page detecting again never changes what an id
// from the first one means, and a file is never named at all: no path crosses this boundary in either
// direction. A private window reads nothing and answers every request the same way.
import { createHmac, randomBytes } from 'node:crypto'
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
  /** Every profile any `detect` has listed, by id. A page asking again adds to it and never renumbers it. */
  const known = new Map<string, ImportSource>()
  const secret = randomBytes(16)
  const idOf = (source: ImportSource): string => createHmac('sha256', secret).update(`${source.browser}\0${source.dir}`).digest('hex').slice(0, 16)
  let running = false
  return {
    pages: ['import'],
    handle: async (command, caller) => {
      if (host.isPrivate) return { private: true }
      const request = (typeof command === 'object' && command !== null ? command : {}) as ImportRequest
      switch (request.type) {
        case 'detect': {
          const sources = await host.detect()
          for (const source of sources) known.set(idOf(source), source)
          const listed: ListedSource[] = sources.map((source) => ({ id: idOf(source), key: source.browser, browser: BROWSER_NAMES[source.browser], profile: source.profile }))
          return { private: false, sources: listed, historyOn: host.historyOn(), manager: host.managerAvailable() }
        }
        case 'run': {
          const source = typeof request.id === 'string' && /^[0-9a-f]{16}$/.test(request.id) ? known.get(request.id) : undefined
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
