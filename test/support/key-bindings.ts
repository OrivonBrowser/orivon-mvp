// The keyboard shortcuts a spec presses and reads, as this platform's product binds and shows them.
// `Mod` is Command on macOS and Control elsewhere (src/main/shortcuts/accelerator.ts), a command can
// have its own binding on macOS (`macDefault`), and the menus write a chord with the key symbols a
// Mac shows. Pure: no Electron, so it has a unit test.

import { displayKeys, parseBinding, type Chord, type Platform } from '../../src/main/shortcuts/accelerator.js'
import { commandById, type CommandId } from '../../src/main/shortcuts/commands.js'
import { formatKeys } from '../../src/renderer/overlay/menu/keys.js'

export type InputModifier = 'control' | 'meta' | 'alt' | 'shift'

/** The binding a command has on `platform` before the person changes it. Throws for a command with none. */
export function bindingOf (id: CommandId, platform: Platform = process.platform): string {
  const def = commandById(id)
  const text = platform === 'darwin' ? (def?.macDefault ?? def?.default) : def?.default
  if (text === undefined) throw new Error(`${id} has no default binding on ${platform}`)
  return text
}

function chordOf (binding: string, platform: Platform): Chord {
  const chord = parseBinding(binding, platform)
  if (chord === null) throw new Error(`not a binding: ${binding}`)
  return chord
}

/** What `webContents.sendInputEvent` calls the modifiers a chord holds. */
export function modifiersOf (binding: string, platform: Platform = process.platform): InputModifier[] {
  const chord = chordOf(binding, platform)
  return [
    ...(chord.ctrl ? ['control' as const] : []),
    ...(chord.meta ? ['meta' as const] : []),
    ...(chord.alt ? ['alt' as const] : []),
    ...(chord.shift ? ['shift' as const] : [])
  ]
}

/** Electron's name for the key of a binding: a letter in capitals, otherwise the name `Tab`, `PageUp`, `F12` or the symbol itself. */
export function keyCodeOf (binding: string, platform: Platform = process.platform): string {
  const { key } = chordOf(binding, platform)
  return key.length === 1 ? key.toUpperCase() : key
}

/** The text the menus and tooltips show for a binding: `Ctrl+Shift+T`, and `⇧⌘T` on macOS. */
export function shownBinding (binding: string, platform: Platform = process.platform): string {
  return formatKeys(displayKeys(chordOf(binding, platform), platform), platform)
}

/** The key caps a Settings row shows for a binding: `['Ctrl', 'Alt', 'Y']`, or `['Option', 'Cmd', 'Y']` on macOS. */
export function keyCapsOf (binding: string, platform: Platform = process.platform): string[] {
  return displayKeys(chordOf(binding, platform), platform)
}
