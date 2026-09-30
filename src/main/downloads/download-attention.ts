// What the downloads button has to say beyond its ring: a file waits for an answer, one broke, or one arrived
// since the person last looked. One tracker per window, since looking is per window. Pure: it reads changes
// the service reports and the list when the list itself changed.
import { isActive } from './download-model.js'
import type { DownloadChange, DownloadEntry, DownloadState } from './download-types.js'

/** `warn` (a file is held for Keep or Discard) outranks `failed`, which outranks `done`. */
export type Attention = 'none' | 'done' | 'warn' | 'failed'

export class DownloadAttention {
  private readonly states = new Map<string, DownloadState>()
  private readonly arrived = new Set<string>()
  private readonly broken = new Set<string>()

  /** Starts level with `list`: what is already finished counts as seen. */
  constructor (private readonly list: () => readonly DownloadEntry[]) {
    this.resync()
  }

  note (change: DownloadChange): void {
    if (change === null) { this.resync(); return }
    const before = this.states.get(change.id)
    this.states.set(change.id, change.state)
    if (change.state === 'completed' && before !== 'completed' && before !== 'held') this.arrived.add(change.id)
    else if (change.state === 'interrupted' && before !== 'interrupted') this.broken.add(change.id)
    else if (isActive(change)) this.broken.delete(change.id)
  }

  /** The bubble or the page was opened: what is there has been seen. */
  seen (): void {
    this.arrived.clear()
    this.broken.clear()
  }

  /** Every running download is paused. */
  get pausedOnly (): boolean {
    const running = [...this.states.values()].filter((state) => state === 'progressing' || state === 'paused')
    return running.length > 0 && running.every((state) => state === 'paused')
  }

  value (): Attention {
    if ([...this.states.values()].includes('held')) return 'warn'
    if (this.broken.size > 0) return 'failed'
    return this.arrived.size > 0 ? 'done' : 'none'
  }

  private resync (): void {
    this.states.clear()
    for (const entry of this.list()) this.states.set(entry.id, entry.state)
    for (const set of [this.arrived, this.broken]) for (const id of set) if (!this.states.has(id)) set.delete(id)
  }
}
