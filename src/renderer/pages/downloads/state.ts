// What the Downloads page knows: the list, kept in step with main. A push that names one download patches it;
// one that names none (a removal, a clear, a new download among others) reads the list again.
import type { DownloadEntry } from '../../../main/downloads/download-types.js'
import { internalBridge } from '../shared/bridge.js'
import type { OrivonInternal } from '../shared/bridge.js'
import type { ActionId } from './actions.js'

interface ListReply {
  readonly entries: readonly DownloadEntry[]
  readonly folder: string
  readonly private: boolean
}

export type Change = { readonly kind: 'list' } | { readonly kind: 'entry', readonly id: string }

export class DownloadsState {
  entries: DownloadEntry[] = []
  folder = ''
  isPrivate = false
  loaded = false
  private readonly listeners = new Set<(change: Change) => void>()

  constructor (private readonly bridge: OrivonInternal = internalBridge()) {}

  onChange (listener: (change: Change) => void): () => void {
    this.listeners.add(listener)
    return () => { this.listeners.delete(listener) }
  }

  find (id: string): DownloadEntry | undefined {
    return this.entries.find((entry) => entry.id === id)
  }

  /** Whether "Clear list" has anything to clear: a download that is not running. */
  get clearable (): boolean {
    return this.entries.some((entry) => entry.state !== 'progressing' && entry.state !== 'paused')
  }

  async load (): Promise<void> {
    const reply = await this.bridge.request('downloads', { type: 'list' }) as ListReply | undefined
    if (reply === undefined) return
    this.entries = [...reply.entries]
    this.folder = reply.folder
    this.isPrivate = reply.private
    this.loaded = true
    this.emit({ kind: 'list' })
  }

  /** Listens for main's pushes. `visible` tells whether the page can be seen; a hidden page catches up when it is shown. */
  listen (visible: () => boolean): { readonly catchUp: () => void } {
    let stale = false
    this.bridge.onEvent((topic, payload) => {
      if (topic !== 'downloads.changed') return
      if (!visible()) { stale = true; return }
      this.receive(payload)
    })
    return {
      catchUp: () => {
        if (!stale) return
        stale = false
        void this.load()
      }
    }
  }

  private receive (payload: unknown): void {
    const entry = payload as DownloadEntry | null
    const index = entry === null ? -1 : this.entries.findIndex((candidate) => candidate.id === entry.id)
    if (entry === null || index === -1) { void this.load(); return }
    this.entries[index] = entry
    this.emit({ kind: 'entry', id: entry.id })
  }

  async act (action: ActionId, id: string): Promise<void> {
    await this.bridge.request('downloads', { type: action, id })
  }

  async open (id: string): Promise<void> {
    await this.bridge.request('downloads', { type: 'open', id })
  }

  async clear (): Promise<void> {
    await this.bridge.request('downloads', { type: 'clear' })
  }

  async openFolder (): Promise<void> {
    await this.bridge.request('downloads', { type: 'openFolder' })
  }

  private emit (change: Change): void {
    for (const listener of [...this.listeners]) listener(change)
  }
}
