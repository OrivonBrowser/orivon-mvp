// The shortcuts as the page knows them, and what each row is doing right now:
// waiting, listening for a new key, or telling the person why the one they
// pressed cannot be used. The keystrokes themselves are read in main and
// arrive here as an event, so the page never interprets a key.
import type { OrivonInternal } from '../shared/bridge.js'

export interface ShortcutRow {
  readonly id: string
  readonly label: string
  readonly category: string
  readonly keys: readonly string[] | null
  readonly isDefault: boolean
  readonly aliases: ReadonlyArray<readonly string[]>
}

export type RowMode =
  | { readonly mode: 'idle' }
  | { readonly mode: 'recording' }
  | { readonly mode: 'conflict', readonly binding: string, readonly withId: string, readonly withLabel: string, readonly canSwap: boolean }
  | { readonly mode: 'problem', readonly message: string }

interface Outcome {
  readonly commandId: string
  readonly binding: string | null
  readonly result:
  | { readonly status: 'ok' | 'cancelled' }
  | { readonly status: 'invalid', readonly problem: string }
  | { readonly status: 'conflict', readonly with: string, readonly label: string, readonly canSwap: boolean }
}

const PROBLEMS: Readonly<Record<string, string>> = {
  'needs-modifier': 'Add Ctrl, Alt or Cmd. A key on its own would be taken from what you type.',
  reserved: 'That combination is kept for copying, pasting and closing the app.',
  unknown: 'That combination cannot be used.'
}

export class ShortcutsState {
  rows: readonly ShortcutRow[] = []
  platform = ''
  private readonly modes = new Map<string, RowMode>()

  constructor (private readonly bridge: OrivonInternal, private readonly notify: () => void) {}

  async load (): Promise<void> {
    const reply = await this.bridge.request('shortcuts', { type: 'list' }) as { platform: string, rows: readonly ShortcutRow[] }
    this.platform = reply.platform
    this.rows = reply.rows
  }

  modeOf (id: string): RowMode {
    return this.modes.get(id) ?? { mode: 'idle' }
  }

  /** Called with every event main sends; true when it was one of these. */
  handle (topic: string, payload: unknown): boolean {
    if (topic === 'shortcuts.changed') {
      this.rows = payload as readonly ShortcutRow[]
      this.notify()
      return true
    }
    if (topic !== 'shortcuts.recorded') return false
    const outcome = payload as Outcome
    this.modes.delete(outcome.commandId)
    const { result } = outcome
    if (result.status === 'invalid') this.modes.set(outcome.commandId, { mode: 'problem', message: PROBLEMS[result.problem] ?? PROBLEMS['unknown'] as string })
    else if (result.status === 'conflict' && outcome.binding !== null) {
      this.modes.set(outcome.commandId, { mode: 'conflict', binding: outcome.binding, withId: result.with, withLabel: result.label, canSwap: result.canSwap })
    }
    this.notify()
    return true
  }

  async record (id: string): Promise<void> {
    // Only one row listens at a time; main drops the earlier one.
    for (const [other, mode] of this.modes) if (mode.mode === 'recording' && other !== id) this.modes.delete(other)
    this.modes.set(id, { mode: 'recording' })
    this.notify()
    await this.bridge.request('shortcuts', { type: 'record', id })
  }

  async cancel (id: string): Promise<void> {
    this.modes.delete(id)
    this.notify()
    await this.bridge.request('shortcuts', { type: 'cancelRecording' })
  }

  async clear (id: string): Promise<void> {
    await this.bridge.request('shortcuts', { type: 'clear', id })
  }

  async reset (id: string): Promise<void> {
    this.modes.delete(id)
    await this.bridge.request('shortcuts', { type: 'reset', id })
  }

  async resetAll (): Promise<void> {
    this.modes.clear()
    await this.bridge.request('shortcuts', { type: 'resetAll' })
  }

  async swap (id: string): Promise<void> {
    const mode = this.modeOf(id)
    if (mode.mode !== 'conflict') return
    await this.bridge.request('shortcuts', { type: 'swap', id, other: mode.withId, binding: mode.binding })
    this.modes.delete(id)
    this.notify()
  }

  dismiss (id: string): void {
    this.modes.delete(id)
    this.notify()
  }
}
