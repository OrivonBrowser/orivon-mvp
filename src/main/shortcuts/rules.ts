// What a shortcut may be. A binding is refused when it would take a key a
// person needs for typing, or one the operating system owns, or when it is
// too easy to hit by accident.
import { isFunctionKey, parseBinding } from './accelerator.js'
import type { Chord, Platform } from './accelerator.js'

export type BindingProblem = 'needs-modifier' | 'reserved'

/** Editing and quitting keys, which no page or browser command may take. */
const RESERVED = ['Mod+A', 'Mod+C', 'Mod+V', 'Mod+X', 'Mod+Z', 'Mod+Shift+Z', 'Mod+Y', 'Mod+Q', 'Alt+F4']

/** Null when the chord may be a binding, else why not. A key that types text
 * needs Ctrl, Alt or Cmd with it; only an F-key may stand alone. */
export function checkBinding (chord: Chord, platform: Platform): BindingProblem | null {
  if (!chord.ctrl && !chord.alt && !chord.meta && !isFunctionKey(chord.key)) return 'needs-modifier'
  const reserved = RESERVED.some((text) => {
    const held = parseBinding(text, platform)
    return held !== null && held.key === chord.key && held.ctrl === chord.ctrl && held.alt === chord.alt && held.meta === chord.meta && held.shift === chord.shift
  })
  return reserved ? 'reserved' : null
}
