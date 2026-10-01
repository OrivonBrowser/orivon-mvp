// What the reader page knows: the article its window holds, the four reading preferences, and the pictures
// that have arrived. It never touches the DOM; main.ts draws what it holds, and every change goes to main,
// which owns the settings and the article.
import type { Article } from '../../../main/reader/reader-blocks.js'
import { internalBridge } from '../shared/bridge.js'
import type { OrivonInternal } from '../shared/bridge.js'

export type ReaderStatus = 'loading' | 'ready' | 'empty' | 'error'

export interface Prefs {
  font: string
  size: string
  width: string
  theme: string
}

export type PrefName = keyof Prefs

export const DEFAULT_PREFS: Prefs = { font: 'sans', size: '18', width: 'medium', theme: 'auto' }

interface ArticleReply {
  readonly article?: Article | null
  readonly token?: number
  readonly images?: Record<string, string>
  readonly prefs?: Partial<Prefs>
}

const PREF_NAMES: readonly PrefName[] = ['font', 'size', 'width', 'theme']

export class ReaderState {
  status: ReaderStatus = 'loading'
  article: Article | null = null
  images = new Map<number, string>()
  prefs: Prefs = { ...DEFAULT_PREFS }
  private token = 0
  private readonly listeners = new Set<(what: 'all' | 'prefs' | 'image') => void>()

  constructor (private readonly bridge: OrivonInternal = internalBridge()) {}

  onChange (listener: (what: 'all' | 'prefs' | 'image') => void): void {
    this.listeners.add(listener)
  }

  private changed (what: 'all' | 'prefs' | 'image'): void {
    for (const listener of this.listeners) listener(what)
  }

  /** Asks main for the window's article and the preferences. */
  async load (): Promise<void> {
    let same = false
    try {
      const reply = await this.bridge.request('reader', { type: 'article' }) as ArticleReply | undefined
      if (reply === undefined || typeof reply !== 'object') throw new Error('no reply')
      this.applyPrefs(reply.prefs)
      const next = reply.article ?? null
      same = next !== null && this.article !== null && next.url === this.article.url && next.title === this.article.title && next.words === this.article.words
      this.article = next
      this.token = reply.token ?? 0
      this.images = new Map(Object.entries(reply.images ?? {}).map(([at, src]) => [Number(at), src]))
      this.status = this.article === null ? 'empty' : 'ready'
    } catch {
      this.article = null
      this.status = 'error'
    }
    // The same article again (another window's reader asked): the page keeps its place.
    this.changed(same ? 'image' : 'all')
  }

  private applyPrefs (incoming: Partial<Prefs> | undefined): void {
    if (incoming === undefined) return
    for (const name of PREF_NAMES) {
      const value = incoming[name]
      if (typeof value === 'string') this.prefs[name] = value
    }
  }

  /** What main pushes: another article, a changed setting, a picture that was copied. */
  handle (topic: string, payload: unknown): void {
    const body = (typeof payload === 'object' && payload !== null ? payload : {}) as { key?: unknown, value?: unknown, token?: unknown, at?: unknown, src?: unknown }
    if (topic === 'reader.changed') {
      void this.load()
    } else if (topic === 'reader.settings' && typeof body.key === 'string' && typeof body.value === 'string') {
      const name = body.key.replace(/^reader\./, '') as PrefName
      if (PREF_NAMES.includes(name)) {
        this.prefs[name] = body.value
        this.changed('prefs')
      }
    } else if (topic === 'reader.image' && body.token === this.token && typeof body.at === 'number' && typeof body.src === 'string') {
      this.images.set(body.at, body.src)
      this.changed('image')
    }
  }

  /** Applies a preference at once and tells main; main's refusal puts the old value back. */
  async setPref (name: PrefName, value: string): Promise<void> {
    const before = this.prefs[name]
    if (before === value) return
    this.prefs[name] = value
    this.changed('prefs')
    let ok = false
    try {
      const reply = await this.bridge.request('reader', { type: 'pref', key: `reader.${name}`, value }) as { ok?: boolean } | undefined
      ok = reply?.ok === true
    } catch {
      ok = false
    }
    if (!ok && this.prefs[name] === value) {
      this.prefs[name] = before
      this.changed('prefs')
    }
  }

  back (): void {
    void this.bridge.request('reader', { type: 'back' })
  }

  print (): void {
    void this.bridge.request('reader', { type: 'print' })
  }

  openLink (index: number): void {
    void this.bridge.request('reader', { type: 'open', index })
  }
}
