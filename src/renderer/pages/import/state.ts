// What the Import page knows, as a step machine: looking for browsers, choosing one, importing, and how it
// ended. Main holds the truth about which profiles exist and what an import did; this holds what the person
// has ticked and which step they are on.
import type { ImportResult } from '../../../main/import/import-types.js'
import { internalBridge } from '../shared/bridge.js'
import type { OrivonInternal } from '../shared/bridge.js'
import type { PageError } from './copy.js'

export type Step = 'detecting' | 'choosing' | 'running' | 'done' | 'error' | 'private'
export type BrowserKey = 'chrome' | 'chromium' | 'edge' | 'brave' | 'firefox'

export interface SourceRow {
  readonly id: string
  readonly key: BrowserKey
  readonly browser: string
  readonly profile: string
}

interface DetectReply {
  readonly private?: boolean
  readonly sources?: readonly SourceRow[]
  readonly historyOn?: boolean
  readonly manager?: boolean
}

interface RunReply {
  readonly private?: boolean
  readonly busy?: boolean
  readonly cancelled?: boolean
  readonly result?: ImportResult
}

export class ImportState {
  step: Step = 'detecting'
  sources: readonly SourceRow[] = []
  historyOn = true
  manager = false
  /** The row chosen: an index into `sources`, or `sources.length` for the bookmarks file. */
  selected = 0
  bookmarks = true
  history = true
  phase: 'bookmarks' | 'history' | null = null
  result: ImportResult | null = null
  error: PageError | null = null
  /** The browser the last import read from; null for a file. */
  from: string | null = null
  private readonly listeners = new Set<() => void>()

  constructor (private readonly bridge: OrivonInternal = internalBridge()) {
    bridge.onEvent((topic, payload) => {
      if (topic === 'settings.changed') {
        const change = payload as { key?: unknown, value?: unknown } | null
        if (change?.key !== 'history.remember') return
        this.historyOn = change.value !== false
        this.changed()
        return
      }
      if (topic !== 'import.progress' || this.step !== 'running') return
      this.phase = payload === 'history' ? 'history' : 'bookmarks'
      this.changed()
    })
  }

  onChange (listener: () => void): void {
    this.listeners.add(listener)
  }

  /** Whether the chosen row is the bookmarks file, which has nothing to tick. */
  get isFile (): boolean {
    return this.selected >= this.sources.length
  }

  get source (): SourceRow | undefined {
    return this.sources[this.selected]
  }

  /** What would be imported: the file always, a profile when it has a box ticked. */
  get canImport (): boolean {
    if (this.step !== 'choosing') return false
    return this.isFile || this.bookmarks || (this.history && this.historyOn)
  }

  async detect (): Promise<void> {
    this.step = 'detecting'
    this.changed()
    let reply: DetectReply | undefined
    try {
      reply = await this.bridge.request('import', { type: 'detect' }) as DetectReply | undefined
    } catch {
      reply = undefined
    }
    if (reply?.private === true) {
      this.step = 'private'
    } else if (reply?.sources === undefined) {
      this.fail('unreadable', null)
      return
    } else {
      this.sources = reply.sources
      this.historyOn = reply.historyOn !== false
      this.manager = reply.manager === true
      this.selected = Math.min(this.selected, this.sources.length)
      this.step = 'choosing'
    }
    this.changed()
  }

  select (index: number): void {
    const next = Math.min(Math.max(index, 0), this.sources.length)
    if (next === this.selected || this.step !== 'choosing') return
    this.selected = next
    this.changed()
  }

  tick (what: 'bookmarks' | 'history', value: boolean): void {
    if (what === 'bookmarks') this.bookmarks = value
    else this.history = value
    this.changed()
  }

  async start (): Promise<void> {
    if (!this.canImport) return
    const source = this.source
    this.step = 'running'
    this.phase = 'bookmarks'
    this.from = source?.browser ?? null
    this.changed()
    let reply: RunReply | undefined
    try {
      reply = await this.bridge.request('import', source === undefined
        ? { type: 'runHtml' }
        : { type: 'run', id: source.id, bookmarks: this.bookmarks, history: this.history && this.historyOn }) as RunReply | undefined
    } catch {
      reply = undefined
    }
    this.phase = null
    if (reply?.private === true) {
      this.step = 'private'
    } else if (reply?.cancelled === true) {
      this.step = 'choosing'
    } else if (reply?.busy === true) {
      this.fail('busy', this.from)
      return
    } else if (reply?.result === undefined) {
      this.fail('unreadable', this.from)
      return
    } else {
      this.finish(reply.result)
      return
    }
    this.changed()
  }

  private finish (result: ImportResult): void {
    this.result = result
    if (result.error === undefined) {
      this.step = 'done'
    } else {
      this.error = result.error
      this.step = 'error'
    }
    this.changed()
  }

  private fail (reason: PageError, from: string | null): void {
    this.error = reason
    this.from = from
    this.result = null
    this.step = 'error'
    this.changed()
  }

  /** From an error or a result back to the choice, keeping what was chosen. */
  again (): void {
    this.result = null
    this.error = null
    this.step = 'choosing'
    this.changed()
  }

  async openManager (): Promise<void> {
    await this.bridge.request('import', { type: 'open', target: 'bookmarks' })
  }

  private changed (): void {
    for (const listener of this.listeners) listener()
  }
}
