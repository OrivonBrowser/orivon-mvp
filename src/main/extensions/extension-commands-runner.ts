// The keys of extension commands in the running shell. Keeps the table of which
// command each key runs (extension-commands.ts decides it), answers the shortcut
// dispatcher, carries a pressed command out, and records the key a person picks
// for one on the shortcuts page. Everything it reaches comes through `deps`, so
// a test supplies fakes; install-extension-commands.ts supplies the real ones.
import type { Rectangle, WebContents } from 'electron'
import { displayKeys, matches, parseBinding } from '../shortcuts/accelerator.js'
import type { Chord, Platform } from '../shortcuts/accelerator.js'
import { commandById } from '../shortcuts/commands.js'
import type { CommandId } from '../shortcuts/commands.js'
import type { ShellWindow } from '../shell/window-registry.js'
import { assign, parseCommands, resolveBindings, toChromeText } from './extension-commands.js'
import type { AssignOutcome, CommandEntry, CommandKind, ExtensionCommandSet } from './extension-commands.js'
import type { ExtensionPrefsStore } from './extension-prefs.js'

export interface LoadedExtension {
  readonly id: string
  readonly name: string
  readonly manifest: unknown
}

export type RecordedOutcome =
  | { readonly extensionId: string, readonly name: string, readonly keys: readonly string[], readonly result: AssignOutcome }
  | { readonly extensionId: string, readonly name: string, readonly keys: null, readonly result: { readonly status: 'cancelled' } }

export interface CommandKeysDeps {
  readonly platform: Platform
  readonly prefs: ExtensionPrefsStore
  /** The enabled, loaded extensions, the first installed first. */
  readonly extensions: () => readonly LoadedExtension[]
  /** Calls back when an extension loads or unloads. Returns the removal. */
  readonly onExtensionsChanged: (listener: () => void) => () => void
  readonly host: () => {
    sendCommand: (extensionId: string, name: string, tab: WebContents | undefined) => void
    activateAction: (extensionId: string, tab: WebContents, anchor: Rectangle) => void
    listActions: () => ReadonlyArray<{ id: string }>
  } | undefined
  /** Counts the key press as an invocation of the extension on the tab, as a click on its icon would. */
  readonly recordInvocation: (extensionId: string, tab: WebContents) => void
  /** A tab no extension is told about: a registered app's, or one that is not a page of the extensions' own session (an internal page). */
  readonly isHiddenTab: (tab: WebContents) => boolean
  /** Where a popup opens for `extensionId` in `window`: under its icon, else under the Extensions button. */
  readonly anchorFor: (window: ShellWindow, extensionId: string) => Promise<Rectangle>
  /** The page that recorded a key hears what came of it. */
  readonly recorded: (page: unknown, outcome: RecordedOutcome) => void
  /** Tells an extension that the key of one of its commands changed (`chrome.commands.onChanged`). */
  readonly keyChanged: (extensionId: string, change: { name: string, oldShortcut: string, newShortcut: string }) => void
  /** Opens the extension's side panel; absent while nothing can. */
  readonly openSidePanel?: (extensionId: string, tab: WebContents, window: ShellWindow) => boolean
  readonly log: (message: string) => void
}

/** What the shortcut service gives this once the saved shortcuts are read. */
export interface OrivonKeys {
  commandFor: (chord: Chord) => CommandId | null
  onChange: (listener: () => void) => () => void
}

export interface KeysEnvironment {
  readonly shortcuts: OrivonKeys
  readonly windows: {
    findOwner: (contents: WebContents) => ShellWindow | undefined
    focused: () => ShellWindow | undefined
  }
}

export interface CommandRow {
  readonly name: string
  readonly description: string
  readonly kind: CommandKind
  readonly keys: readonly string[] | null
  /** A suggested key that was left unused, as key caps. */
  readonly suggestedKeys: readonly string[] | null
  /** Why the command cannot run here, or null. */
  readonly unavailable: string | null
}

export interface ExtensionCommandGroup {
  readonly id: string
  readonly name: string
  readonly commands: readonly CommandRow[]
}

export interface ExtensionCommandKeys {
  readonly platform: Platform
  /** The key caps of a binding written like `Mod+Shift+Y`; empty for one that is not a binding. */
  capsOf: (binding: string) => readonly string[]
  /** Called once the saved shortcuts are loaded: until then nothing is bound. */
  ready: (env: KeysEnvironment) => void
  whenReady: () => Promise<void>
  handles: (chord: Chord) => boolean
  run: (chord: Chord, contents: WebContents) => boolean
  isRecording: (owner: unknown) => boolean
  record: (owner: unknown, chord: Chord) => void
  beginRecording: (owner: unknown, extensionId: string, name: string) => boolean
  cancelRecording: () => void
  clear: (extensionId: string, name: string) => boolean
  move: (extensionId: string, name: string, chord: Chord) => AssignOutcome
  groups: () => ExtensionCommandGroup[]
  getAll: (extensionId: string) => Array<{ name: string, description: string, shortcut: string }>
  /** Called when the table changes: an extension loads, a key is chosen, an Orivon shortcut moves. */
  onChange: (listener: () => void) => () => void
}

const SIDE_PANEL_UNAVAILABLE = 'Side panels are not available yet.'

export function createExtensionCommandKeys (deps: CommandKeysDeps): ExtensionCommandKeys {
  let env: KeysEnvironment | undefined
  let table: CommandEntry[] | null = null
  let recording: { owner: unknown, extensionId: string, name: string } | null = null
  const listeners = new Set<() => void>()
  let release: (() => void) | undefined
  const ready = new Promise<void>((resolve) => { release = resolve })

  const invalidate = (): void => { table = null }
  // A choice made on the page already reaches it through the preferences' own notice.
  const changed = (): void => {
    invalidate()
    for (const listener of listeners) listener()
  }
  deps.onExtensionsChanged(changed)
  deps.prefs.onChange(invalidate)

  const orivonHolds = (chord: Chord): CommandId | null => env?.shortcuts.commandFor(chord) ?? null
  const orivonLabel = (chord: Chord): string | null => {
    const id = orivonHolds(chord)
    return id === null ? null : (commandById(id)?.label ?? id)
  }

  function current (): CommandEntry[] {
    if (env === undefined) return []
    table ??= resolveBindings(sets(), deps.platform, (chord) => orivonHolds(chord) !== null)
    return table
  }

  function sets (): ExtensionCommandSet[] {
    return deps.extensions()
      .map((extension) => ({
        id: extension.id,
        name: extension.name,
        commands: parseCommands(extension.manifest, deps.platform),
        chosen: deps.prefs.get(extension.id).shortcuts
      }))
      .filter((set) => set.commands.length > 0)
  }

  const capsOf = (binding: string): readonly string[] => {
    const chord = parseBinding(binding, deps.platform)
    return chord === null ? [] : displayKeys(chord, deps.platform)
  }
  const formatKeys = (outcome: AssignOutcome): string => outcome.status === 'invalid' ? '' : outcome.binding

  const find = (chord: Chord): CommandEntry | undefined => current().find((entry) => entry.chord !== null && matches(chord, entry.chord))
  const entryOf = (extensionId: string, name: string): CommandEntry | undefined =>
    current().find((entry) => entry.extensionId === extensionId && entry.name === name)

  function choose (extensionId: string, name: string, binding: string): void {
    deps.prefs.update(extensionId, { shortcuts: { ...deps.prefs.get(extensionId).shortcuts, [name]: binding } })
  }

  const shortcutTexts = (): Map<string, { extensionId: string, name: string, text: string }> => new Map(current().map((entry) => [
    `${entry.extensionId}\u0000${entry.name}`,
    { extensionId: entry.extensionId, name: entry.name, text: entry.binding === null ? '' : (toChromeText(entry.binding, deps.platform) ?? '') }
  ]))

  /** Runs a change the page asked for and tells each extension whose command ended up on another key. */
  function announcing<T> (change: () => T): T {
    const before = shortcutTexts()
    const result = change()
    for (const [key, now] of shortcutTexts()) {
      const was = before.get(key)?.text ?? ''
      if (was !== now.text) deps.keyChanged(now.extensionId, { name: now.name, oldShortcut: was, newShortcut: now.text })
    }
    return result
  }

  function unavailable (entry: CommandEntry): string | null {
    return entry.kind === 'side-panel' && deps.openSidePanel === undefined ? SIDE_PANEL_UNAVAILABLE : null
  }

  /** The window's active tab, which a command key acts on. */
  function tabFor (window: ShellWindow): WebContents | undefined {
    const tab = window.tabs.activeWebContents()
    return tab === undefined || tab.isDestroyed() ? undefined : tab
  }

  function activate (window: ShellWindow, extensionId: string, tab: WebContents): void {
    const host = deps.host()
    void deps.anchorFor(window, extensionId).then((anchor) => {
      if (!tab.isDestroyed()) host?.activateAction(extensionId, tab, anchor)
    }).catch((error: unknown) => { deps.log(`a shortcut could not open ${extensionId}'s action: ${String(error)}`) })
  }

  return {
    platform: deps.platform,
    capsOf,
    ready: (environment) => {
      env = environment
      environment.shortcuts.onChange(changed)
      invalidate()
      release?.()
    },
    whenReady: async () => { await ready },
    handles: (chord) => find(chord) !== undefined,
    run: (chord, contents) => {
      const entry = find(chord)
      const host = deps.host()
      if (entry === undefined || env === undefined || host === undefined) return false
      const window = env.windows.findOwner(contents) ?? env.windows.focused()
      if (window === undefined || window.window.isDestroyed()) return false
      const tab = tabFor(window)
      const visible = tab !== undefined && !deps.isHiddenTab(tab) ? tab : undefined
      if (entry.kind === 'action') {
        if (visible === undefined || !host.listActions().some((action) => action.id === entry.extensionId)) return false
        activate(window, entry.extensionId, visible)
        return true
      }
      if (entry.kind === 'side-panel') return visible !== undefined && deps.openSidePanel?.(entry.extensionId, visible, window) === true
      if (visible !== undefined) deps.recordInvocation(entry.extensionId, visible)
      host.sendCommand(entry.extensionId, entry.name, visible)
      return true
    },
    isRecording: (owner) => recording?.owner === owner,
    beginRecording: (owner, extensionId, name) => {
      if (entryOf(extensionId, name) === undefined) return false
      // One recording at a time: a page whose recording is replaced hears that it ended, so it leaves "Press a shortcut".
      const previous = recording
      recording = { owner, extensionId, name }
      if (previous !== null && previous.owner !== owner) {
        deps.recorded(previous.owner, { extensionId: previous.extensionId, name: previous.name, keys: null, result: { status: 'cancelled' } })
      }
      return true
    },
    cancelRecording: () => { recording = null },
    record: (owner, chord) => {
      const active = recording
      if (active === null || active.owner !== owner) return
      recording = null
      const { extensionId, name } = active
      if (chord.key === 'Escape' && !chord.ctrl && !chord.alt && !chord.shift && !chord.meta) {
        deps.recorded(owner, { extensionId, name, keys: null, result: { status: 'cancelled' } })
        return
      }
      if (entryOf(extensionId, name) === undefined) {
        deps.recorded(owner, { extensionId, name, keys: null, result: { status: 'cancelled' } })
        return
      }
      const outcome = assign(current(), { extensionId, name }, chord, deps.platform, orivonLabel)
      if (outcome.status === 'ok') announcing(() => { choose(extensionId, name, outcome.binding) })
      deps.recorded(owner, { extensionId, name, keys: capsOf(formatKeys(outcome)), result: outcome })
    },
    clear: (extensionId, name) => {
      if (entryOf(extensionId, name) === undefined) return false
      announcing(() => { choose(extensionId, name, '') })
      return true
    },
    move: (extensionId, name, chord) => {
      if (entryOf(extensionId, name) === undefined) return { status: 'invalid', problem: 'unsupported' }
      const outcome = assign(current(), { extensionId, name }, chord, deps.platform, orivonLabel)
      if (outcome.status === 'extension') {
        announcing(() => {
          choose(outcome.holder.extensionId, outcome.holder.name, '')
          choose(extensionId, name, outcome.binding)
        })
      } else if (outcome.status === 'ok') announcing(() => { choose(extensionId, name, outcome.binding) })
      return outcome
    },
    groups: () => {
      const byExtension = new Map<string, { id: string, name: string, commands: CommandRow[] }>()
      for (const entry of current()) {
        const group = byExtension.get(entry.extensionId) ?? { id: entry.extensionId, name: entry.extensionName, commands: [] }
        byExtension.set(entry.extensionId, group)
        const suggestedChord = entry.suggestedBlocked && entry.suggested !== null ? parseBinding(entry.suggested, deps.platform) : null
        group.commands.push({
          name: entry.name,
          description: entry.description,
          kind: entry.kind,
          keys: entry.chord === null ? null : displayKeys(entry.chord, deps.platform),
          suggestedKeys: suggestedChord === null ? null : displayKeys(suggestedChord, deps.platform),
          unavailable: unavailable(entry)
        })
      }
      return [...byExtension.values()]
    },
    getAll: (extensionId) => current()
      .filter((entry) => entry.extensionId === extensionId)
      .map((entry) => ({ name: entry.name, description: entry.description, shortcut: entry.binding === null ? '' : (toChromeText(entry.binding, deps.platform) ?? '') })),
    onChange: (listener) => {
      listeners.add(listener)
      return () => { listeners.delete(listener) }
    }
  }
}
