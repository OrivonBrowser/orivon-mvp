// What the shortcuts are right now: the defaults with the person's changes on
// top, which chord runs which command, and the rules for changing one. Pure
// over the store it is given; the key handling that calls it is
// ./dispatcher.ts.
import { chordId, displayKeys, formatBinding, matches, parseBinding } from './accelerator.js'
import type { Chord, Platform } from './accelerator.js'
import { COMMANDS, commandById, isCommandId } from './commands.js'
import type { CommandCategory, CommandDef, CommandId } from './commands.js'
import { checkBinding } from './rules.js'
import type { BindingProblem } from './rules.js'
import type { ShortcutStore } from './shortcut-store.js'

export type SetOutcome =
  | { readonly status: 'ok' }
  | { readonly status: 'invalid', readonly problem: BindingProblem | 'unknown' }
  /** `canSwap`: the other command holds it as its own binding, not as a fixed alias, so trading is possible. */
  | { readonly status: 'conflict', readonly with: CommandId, readonly label: string, readonly canSwap: boolean }

export type RecordOutcome =
  | { readonly commandId: CommandId, readonly result: SetOutcome, readonly binding: string }
  | { readonly commandId: CommandId, readonly result: { readonly status: 'cancelled' }, readonly binding: null }

export interface ShortcutRow {
  readonly id: CommandId
  readonly label: string
  readonly category: CommandCategory
  /** Key caps of the binding, or null when it is cleared. */
  readonly keys: readonly string[] | null
  readonly isDefault: boolean
  readonly aliases: ReadonlyArray<readonly string[]>
}

interface Entry {
  readonly id: CommandId
  readonly chord: Chord
  readonly fixed: boolean
}

export class ShortcutService {
  private entries: Entry[] | null = null
  private recording: { owner: unknown, id: CommandId } | null = null
  private readonly listeners = new Set<() => void>()

  constructor (private readonly store: ShortcutStore, readonly platform: Platform) {}

  private defaultFor (def: CommandDef): string | undefined {
    return this.platform === 'darwin' ? (def.macDefault ?? def.default) : def.default
  }

  /** The chord a command's own binding is, or null when the person cleared it. */
  primary (id: CommandId): Chord | null {
    const def = commandById(id)
    if (def === undefined) return null
    const changed = this.store.get(id)
    if (changed === null) return null
    const text = changed ?? this.defaultFor(def)
    return text === undefined ? null : parseBinding(text, this.platform)
  }

  private aliases (def: CommandDef): Chord[] {
    return (def.aliases ?? []).flatMap((text) => parseBinding(text, this.platform) ?? [])
  }

  private allEntries (): Entry[] {
    this.entries ??= COMMANDS.flatMap((def): Entry[] => {
      const own = this.primary(def.id)
      return [
        ...(own === null ? [] : [{ id: def.id, chord: own, fixed: false }]),
        ...this.aliases(def).map((chord) => ({ id: def.id, chord, fixed: true }))
      ]
    })
    return this.entries
  }

  /** The command a pressed chord runs, if any. */
  commandFor (pressed: Chord): CommandId | null {
    return this.allEntries().find((entry) => matches(pressed, entry.chord))?.id ?? null
  }

  isRepeatable (id: CommandId): boolean {
    return commandById(id)?.repeatable === true
  }

  /** The key caps of a command's own binding, or null when it is cleared. */
  keysOf (id: CommandId): readonly string[] | null {
    const own = this.primary(id)
    return own === null ? null : displayKeys(own, this.platform)
  }

  /** Every command as the Shortcuts section lists it. */
  rows (): ShortcutRow[] {
    return COMMANDS.map((def) => {
      const own = this.primary(def.id)
      return {
        id: def.id,
        label: def.label,
        category: def.category,
        keys: own === null ? null : displayKeys(own, this.platform),
        isDefault: this.store.get(def.id) === undefined,
        aliases: this.aliases(def).map((chord) => displayKeys(chord, this.platform))
      }
    })
  }

  onChange (listener: () => void): () => void {
    this.listeners.add(listener)
    return () => { this.listeners.delete(listener) }
  }

  /** `binding` is written like `Mod+Shift+T`. */
  set (id: string, binding: string): SetOutcome {
    const chord = parseBinding(binding, this.platform)
    if (!isCommandId(id) || chord === null) return { status: 'invalid', problem: 'unknown' }
    const problem = checkBinding(chord, this.platform)
    if (problem !== null) return { status: 'invalid', problem }
    const holder = this.allEntries().find((entry) => entry.id !== id && chordId(entry.chord) === chordId(chord))
    if (holder !== undefined) {
      return { status: 'conflict', with: holder.id, label: commandById(holder.id)?.label ?? holder.id, canSwap: !holder.fixed }
    }
    this.change(new Map([[id, this.storable(id, chord)]]))
    return { status: 'ok' }
  }

  /** Gives `id` the binding and hands `other` what `id` had. Only when `other`
   * holds that binding as its own (an alias is fixed and cannot be traded). */
  swap (id: string, other: string, binding: string): SetOutcome {
    const chord = parseBinding(binding, this.platform)
    if (!isCommandId(id) || !isCommandId(other) || id === other || chord === null) return { status: 'invalid', problem: 'unknown' }
    const held = this.primary(other)
    if (held === null || chordId(held) !== chordId(chord)) return { status: 'invalid', problem: 'unknown' }
    const problem = checkBinding(chord, this.platform)
    if (problem !== null) return { status: 'invalid', problem }
    const mine = this.primary(id)
    this.change(new Map<CommandId, string | null | undefined>([
      [id, this.storable(id, chord)],
      [other, mine === null ? null : this.storable(other, mine)]
    ]))
    return { status: 'ok' }
  }

  clear (id: string): void {
    if (isCommandId(id)) this.change(new Map([[id, null]]))
  }

  reset (id: string): void {
    if (isCommandId(id)) this.change(new Map([[id, undefined]]))
  }

  resetAll (): void {
    this.store.resetAll()
    this.entries = null
    this.notify()
  }

  /** What to store for `id` holding `chord`: nothing at all when that is its default. */
  private storable (id: CommandId, chord: Chord): string | undefined {
    const def = commandById(id)
    const text = formatBinding(chord, this.platform)
    const standard = def === undefined ? undefined : this.defaultFor(def)
    const standardChord = standard === undefined ? null : parseBinding(standard, this.platform)
    return standardChord !== null && chordId(standardChord) === chordId(chord) ? undefined : text
  }

  private change (changes: Map<CommandId, string | null | undefined>): void {
    this.store.setMany(changes)
    this.entries = null
    this.notify()
  }

  private notify (): void {
    for (const listener of this.listeners) listener()
  }

  // ---- recording: the next chord a person presses becomes a command's binding

  /** `owner` is whatever will feed the keys back (the page's webContents). */
  beginRecording (owner: unknown, id: string): boolean {
    if (!isCommandId(id)) return false
    this.recording = { owner, id }
    return true
  }

  isRecording (owner: unknown): boolean {
    return this.recording?.owner === owner
  }

  cancelRecording (): void {
    this.recording = null
  }

  /** Feeds a pressed key while recording. Null while it is still waiting (a
   * modifier alone); otherwise the outcome, and recording has ended. Escape
   * on its own cancels. A conflict is reported, not applied: the page decides
   * whether to swap. */
  recordChord (owner: unknown, chord: Chord | null): RecordOutcome | null {
    const recording = this.recording
    if (recording === null || recording.owner !== owner || chord === null) return null
    this.recording = null
    if (chord.key === 'Escape' && !chord.ctrl && !chord.alt && !chord.shift && !chord.meta) {
      return { commandId: recording.id, result: { status: 'cancelled' }, binding: null }
    }
    const binding = formatBinding(chord, this.platform)
    return { commandId: recording.id, result: this.set(recording.id, binding), binding }
  }
}
