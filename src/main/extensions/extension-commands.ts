// What an extension's `commands` manifest key means in Orivon: the commands it
// declares, the key each suggests on this platform, which key each ends up
// bound to (the person's choice, else a free suggestion), and whether a key the
// person records may be assigned. Pure: the key handling is
// extension-commands-runner.ts, the chords come from ../shortcuts/accelerator.ts.
import { formatBinding, matches, parseBinding } from '../shortcuts/accelerator.js'
import type { Chord, Platform } from '../shortcuts/accelerator.js'
import { checkBinding } from '../shortcuts/rules.js'

export type CommandKind = 'action' | 'side-panel' | 'named'

export interface ExtensionCommand {
  readonly name: string
  /** The manifest's text, possibly a `__MSG_x__` reference; '' when it gives none. */
  readonly description: string
  readonly kind: CommandKind
  /** The suggested key as an Orivon binding (`Mod+Shift+Y`), or null when it names none on this platform or cannot be used. */
  readonly suggested: string | null
}

export interface ExtensionCommandSet {
  readonly id: string
  readonly name: string
  readonly commands: readonly ExtensionCommand[]
  /** `prefs.shortcuts`: command name to binding, '' for one the person cleared. */
  readonly chosen: Readonly<Record<string, string>>
}

export interface CommandEntry {
  readonly extensionId: string
  readonly extensionName: string
  readonly name: string
  readonly description: string
  readonly kind: CommandKind
  readonly suggested: string | null
  /** What the command is bound to now, as an Orivon binding; null when it has no key. */
  readonly binding: string | null
  readonly chord: Chord | null
  /** A suggested key exists and was left unused because Orivon or an earlier command holds it. */
  readonly suggestedBlocked: boolean
}

export type AssignProblem = 'needs-modifier' | 'reserved' | 'unsupported'

export type AssignOutcome =
  | { readonly status: 'ok', readonly binding: string }
  | { readonly status: 'invalid', readonly problem: AssignProblem }
  | { readonly status: 'orivon', readonly binding: string, readonly label: string }
  | { readonly status: 'extension', readonly binding: string, readonly holder: { readonly extensionId: string, readonly extensionName: string, readonly name: string, readonly description: string } }

const ACTION_COMMANDS = new Set(['_execute_action', '_execute_browser_action', '_execute_page_action'])
const SIDE_PANEL_COMMAND = '_execute_side_panel'

/** The keys a manifest may name, in Orivon's grammar: letters and digits are written as themselves. */
const NAMED_KEY: Readonly<Record<string, string>> = {
  Comma: ',', Period: '.', Home: 'Home', End: 'End', PageUp: 'PageUp', PageDown: 'PageDown', Space: 'Space',
  Insert: 'Insert', Delete: 'Delete', Up: 'Up', Down: 'Down', Left: 'Left', Right: 'Right'
}
const CHROME_NAME: Readonly<Record<string, string>> = Object.fromEntries(Object.entries(NAMED_KEY).map(([name, key]) => [key, name]))

const isChromeKey = (key: string): boolean => /^[a-z0-9]$/.test(key) || /^F([1-9]|1[0-2])$/.test(key) || key in CHROME_NAME

const PLATFORM_KEY: Readonly<Record<string, string>> = { win32: 'windows', darwin: 'mac', linux: 'linux' }

function kindOf (name: string): CommandKind {
  if (ACTION_COMMANDS.has(name)) return 'action'
  return name === SIDE_PANEL_COMMAND ? 'side-panel' : 'named'
}

/** `Ctrl+Shift+Y` as the manifest writes it, read as an Orivon binding; null for text no key follows. On macOS `Ctrl`
 * and `Command` both mean the command key and `MacCtrl` the control key, as in the manifest's own grammar; `Command` and
 * `MacCtrl` mean nothing elsewhere. */
export function toBinding (chromeKey: string, platform: Platform): string | null {
  const parts = chromeKey.split('+').map((part) => part.trim())
  const keyName = parts.pop() ?? ''
  const mac = platform === 'darwin'
  let ctrl = false
  let alt = false
  let shift = false
  let meta = false
  for (const part of parts) {
    if (part === 'Ctrl' || (part === 'Command' && mac)) {
      if (mac ? meta : ctrl) return null
      if (mac) meta = true
      else ctrl = true
    } else if (part === 'MacCtrl' && mac) {
      if (ctrl) return null
      ctrl = true
    } else if (part === 'Alt') {
      if (alt) return null
      alt = true
    } else if (part === 'Shift') {
      if (shift) return null
      shift = true
    } else return null
  }
  const key = keyName.length === 1 ? keyName.toLowerCase() : (NAMED_KEY[keyName] ?? keyName)
  if (!isChromeKey(key)) return null
  return formatBinding({ ctrl, alt, shift, meta, key }, platform)
}

/** The text `chrome.commands.getAll` reports for a binding, written in the manifest's own grammar so it reads back. */
export function toChromeText (binding: string, platform: Platform): string | null {
  const chord = parseBinding(binding, platform)
  if (chord === null) return null
  const mac = platform === 'darwin'
  const parts: string[] = []
  if (chord.meta) parts.push(mac ? 'Command' : 'Meta')
  if (chord.ctrl) parts.push(mac ? 'MacCtrl' : 'Ctrl')
  if (chord.alt) parts.push('Alt')
  if (chord.shift) parts.push('Shift')
  parts.push(CHROME_NAME[chord.key] ?? (chord.key.length === 1 ? chord.key.toUpperCase() : chord.key))
  return parts.join('+')
}

function suggestedText (value: unknown, platform: Platform): string | null {
  if (typeof value === 'string') return value
  if (typeof value !== 'object' || value === null) return null
  const byPlatform = value as Readonly<Record<string, unknown>>
  const own = byPlatform[PLATFORM_KEY[platform] ?? '']
  const picked = typeof own === 'string' ? own : byPlatform['default']
  return typeof picked === 'string' ? picked : null
}

/** The manifest's commands, in the order it lists them. Anything malformed is left out. */
export function parseCommands (manifest: unknown, platform: Platform): ExtensionCommand[] {
  const declared = typeof manifest === 'object' && manifest !== null ? (manifest as { commands?: unknown }).commands : undefined
  if (typeof declared !== 'object' || declared === null || Array.isArray(declared)) return []
  const commands: ExtensionCommand[] = []
  for (const [name, details] of Object.entries(declared)) {
    if (typeof details !== 'object' || details === null) continue
    const { description, suggested_key: key } = details as { description?: unknown, suggested_key?: unknown }
    const text = suggestedText(key, platform)
    const binding = text === null ? null : toBinding(text, platform)
    const chord = binding === null ? null : parseBinding(binding, platform)
    commands.push({
      name,
      description: typeof description === 'string' ? description : '',
      kind: kindOf(name),
      // The same refusals a recorded key meets: a bare letter or an editing key is never a suggestion.
      suggested: binding !== null && chord !== null && checkBinding(chord, platform) === null ? binding : null
    })
  }
  return commands
}

/** Which binding each command ends up with. A key the person chose stands first, in install order; then a suggestion
 * stands where Orivon (`heldByOrivon`) and every earlier command leave its key free. */
export function resolveBindings (sets: readonly ExtensionCommandSet[], platform: Platform, heldByOrivon: (chord: Chord) => boolean): CommandEntry[] {
  const entries: Array<{ -readonly [K in keyof CommandEntry]: CommandEntry[K] }> = []
  const taken = (chord: Chord): boolean => heldByOrivon(chord) || entries.some((entry) => entry.chord !== null && (matches(chord, entry.chord) || matches(entry.chord, chord)))
  const usable = (binding: string): Chord | null => {
    const chord = parseBinding(binding, platform)
    return chord !== null && checkBinding(chord, platform) === null && isChromeKey(chord.key) ? chord : null
  }
  for (const set of sets) {
    for (const command of set.commands) {
      entries.push({
        extensionId: set.id, extensionName: set.name, name: command.name, description: command.description, kind: command.kind,
        suggested: command.suggested, binding: null, chord: null, suggestedBlocked: false
      })
    }
  }
  const lookup = (entry: CommandEntry): string | undefined => {
    const chosen = sets.find((set) => set.id === entry.extensionId)?.chosen
    return chosen !== undefined && Object.hasOwn(chosen, entry.name) ? chosen[entry.name] : undefined
  }
  // What the person chose first, so a later extension's choice is never lost to an earlier one's suggestion.
  for (const entry of entries) {
    const chosen = lookup(entry)
    if (chosen === undefined || chosen === '') continue
    const chord = usable(chosen)
    // A key Orivon has since taken for itself stays stored and stops working: it returns if Orivon lets go of it.
    if (chord === null || taken(chord)) continue
    entry.binding = formatBinding(chord, platform)
    entry.chord = chord
  }
  for (const entry of entries) {
    if (lookup(entry) !== undefined || entry.suggested === null) continue
    const chord = usable(entry.suggested)
    if (chord === null || taken(chord)) { entry.suggestedBlocked = true; continue }
    entry.binding = entry.suggested
    entry.chord = chord
  }
  return entries
}

/** Whether `extensionId`'s command `name` may take `chord`. `orivonLabel` names the Orivon command that holds a chord. */
export function assign (
  table: readonly CommandEntry[],
  target: { readonly extensionId: string, readonly name: string },
  chord: Chord,
  platform: Platform,
  orivonLabel: (chord: Chord) => string | null
): AssignOutcome {
  const binding = formatBinding(chord, platform)
  if (!isChromeKey(chord.key) || (chord.meta && platform !== 'darwin')) return { status: 'invalid', problem: 'unsupported' }
  const problem = checkBinding(chord, platform)
  if (problem !== null) return { status: 'invalid', problem }
  const label = orivonLabel(chord)
  if (label !== null) return { status: 'orivon', binding, label }
  const holder = table.find((entry) =>
    entry.chord !== null && !(entry.extensionId === target.extensionId && entry.name === target.name) && (matches(chord, entry.chord) || matches(entry.chord, chord)))
  if (holder !== undefined) {
    return { status: 'extension', binding, holder: { extensionId: holder.extensionId, extensionName: holder.extensionName, name: holder.name, description: holder.description } }
  }
  return { status: 'ok', binding }
}
