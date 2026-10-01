// What the reader page may ask of main: the article its window holds, one of four reading preferences to
// change, to go back to the page, and to open a link. A link is named by its place in the article's own
// table: the page never sends an address, and main opens only what it validated itself.
import type { WebContents } from 'electron'
import type { InternalDomain } from '../pages/internal-ipc.js'
import type { SettingsStore } from '../settings/settings-store.js'
import type { ReaderTabs } from './reader-runner.js'
import { closeReader, placeBeside } from './reader-runner.js'
import type { ReaderArticles } from './reader-store.js'

export const READER_PREFS = ['reader.font', 'reader.size', 'reader.width', 'reader.theme'] as const
type ReaderPref = (typeof READER_PREFS)[number]

export interface ReaderOwner {
  /** What the article is kept under: the reader tab's record. */
  readonly key: object
  readonly tabs: ReaderTabs & { createTab: (url: string, active: boolean) => string }
  readonly tabId: string
  /** Prints the reader tab, as the Print command does. */
  readonly print: () => void
}

export interface ReaderDomainDeps {
  readonly articles: ReaderArticles
  readonly settings: Pick<SettingsStore, 'get' | 'set'>
  readonly ownerOf: (contents: WebContents) => ReaderOwner | undefined
}

const isPref = (value: unknown): value is ReaderPref => typeof value === 'string' && (READER_PREFS as readonly string[]).includes(value)

export function readerPrefs (settings: Pick<SettingsStore, 'get'>): Record<'font' | 'size' | 'width' | 'theme', string> {
  return {
    font: settings.get('reader.font'),
    size: settings.get('reader.size'),
    width: settings.get('reader.width'),
    theme: settings.get('reader.theme')
  }
}

export function readerDomain (deps: ReaderDomainDeps): InternalDomain {
  return {
    pages: ['reader'],
    handle: (command, caller) => {
      const request = (typeof command === 'object' && command !== null ? command : {}) as { type?: unknown, key?: unknown, value?: unknown, index?: unknown }
      const owner = deps.ownerOf(caller.contents)
      switch (request.type) {
        case 'article': {
          const entry = owner === undefined ? undefined : deps.articles.get(owner.key)
          return {
            article: entry?.article ?? null,
            token: entry?.token ?? 0,
            images: Object.fromEntries(entry?.images ?? []),
            prefs: readerPrefs(deps.settings)
          }
        }
        case 'pref': {
          if (!isPref(request.key) || typeof request.value !== 'string') return { ok: false }
          return deps.settings.set(request.key, request.value)
        }
        case 'back':
          if (owner !== undefined) closeReader(owner.tabs, owner.tabId)
          return { ok: owner !== undefined }
        case 'print':
          owner?.print()
          return { ok: owner !== undefined }
        case 'open': {
          const index = request.index
          const entry = owner === undefined ? undefined : deps.articles.get(owner.key)
          if (owner === undefined || entry === undefined || typeof index !== 'number' || !Number.isInteger(index)) return { ok: false }
          const url = entry.links[index]
          if (url === undefined) return { ok: false }
          const id = owner.tabs.createTab(url, false)
          if (id !== '') placeBeside(owner.tabs, id, owner.tabId)
          return { ok: true }
        }
        default:
          return undefined
      }
    }
  }
}
