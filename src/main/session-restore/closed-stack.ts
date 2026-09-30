// The tabs and windows that were closed, newest first, as far back as `CLOSED_STACK_CAP`. Pure.
import type { SavedWindow } from './session-types.js'
import type { TabSnapshot } from './tab-snapshot.js'

export const CLOSED_STACK_CAP = 25

export interface ClosedTabEntry {
  readonly kind: 'tab'
  readonly tab: TabSnapshot
  /** Where it sat in its strip. */
  readonly index: number
  /** `BaseWindow.id` of the window it was closed in. */
  readonly windowKey: number
}

export interface ClosedWindowEntry {
  readonly kind: 'window'
  readonly window: SavedWindow
}

export type NewClosedEntry = ClosedTabEntry | ClosedWindowEntry
export type ClosedEntry = NewClosedEntry & { readonly id: number, readonly at: number }

export type ClosedStackListener = () => void

export class ClosedStack {
  /** Oldest first: the newest is at the end. */
  private readonly entries: ClosedEntry[] = []
  private readonly listeners = new Set<ClosedStackListener>()
  private nextId = 1

  constructor (private readonly cap = CLOSED_STACK_CAP, private readonly now: () => number = Date.now) {}

  push (entry: NewClosedEntry): ClosedEntry {
    const stored: ClosedEntry = { ...entry, id: this.nextId++, at: this.now() }
    this.entries.push(stored)
    if (this.entries.length > this.cap) this.entries.shift()
    this.changed()
    return stored
  }

  /** What `pop` would give back. */
  peek (): ClosedEntry | undefined {
    return this.entries.at(-1)
  }

  pop (): ClosedEntry | undefined {
    const entry = this.entries.pop()
    if (entry !== undefined) this.changed()
    return entry
  }

  /** An entry from anywhere in the stack, for a list that lets the person pick one. */
  take (id: number): ClosedEntry | undefined {
    const position = this.entries.findIndex((entry) => entry.id === id)
    if (position === -1) return undefined
    const [entry] = this.entries.splice(position, 1)
    this.changed()
    return entry
  }

  /** Newest first. */
  list (): readonly ClosedEntry[] {
    return [...this.entries].reverse()
  }

  get size (): number {
    return this.entries.length
  }

  /** Returns the removal. */
  onChange (listener: ClosedStackListener): () => void {
    this.listeners.add(listener)
    return () => { this.listeners.delete(listener) }
  }

  private changed (): void {
    for (const listener of [...this.listeners]) listener()
  }
}
