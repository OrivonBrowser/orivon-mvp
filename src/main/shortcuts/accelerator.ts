// A keyboard shortcut as data: what it is made of, how it is written down, how
// it is read off a key event, and how it is shown. Pure: no Electron, no Node.
// Written down as `Mod+Shift+T`; `Mod` is the command key on macOS and control
// elsewhere, so one binding means the same thing on every platform.

export interface Chord {
  readonly ctrl: boolean
  readonly alt: boolean
  readonly shift: boolean
  readonly meta: boolean
  /** A lowercase letter, a digit, one punctuation character, or a name from NAMED_KEYS or F1..F24. */
  readonly key: string
}

export type Platform = NodeJS.Platform

/** The fields of an Electron key `Input` that a chord is read from. */
export interface KeyInput {
  readonly key: string
  readonly code: string
  readonly control: boolean
  readonly alt: boolean
  readonly shift: boolean
  readonly meta: boolean
}

// `input.key` -> the name a binding uses.
const NAMED_KEYS: Readonly<Record<string, string>> = {
  Tab: 'Tab', Enter: 'Enter', Escape: 'Escape', ' ': 'Space', Backspace: 'Backspace', Delete: 'Delete', Insert: 'Insert',
  Home: 'Home', End: 'End', PageUp: 'PageUp', PageDown: 'PageDown',
  ArrowLeft: 'Left', ArrowRight: 'Right', ArrowUp: 'Up', ArrowDown: 'Down'
}
const NAME_VALUES = new Set(Object.values(NAMED_KEYS))
const MODIFIER_KEYS = new Set(['Control', 'Shift', 'Alt', 'Meta', 'AltGraph', 'CapsLock', 'NumLock', 'ScrollLock', 'OS', 'Hyper', 'Super'])
const FUNCTION_KEY = /^F([1-9]|1\d|2[0-4])$/
const SYMBOLS = '`-=[]\;\',./+'

const isLetter = (character: string): boolean => /^[a-z]$/.test(character)
const isDigit = (character: string): boolean => /^[0-9]$/.test(character)

/** Whether `key` may stand on its own as a binding: an F-key. */
export function isFunctionKey (key: string): boolean {
  return FUNCTION_KEY.test(key)
}

/** The chord a key event makes, or null for one that is only a modifier or a key no binding can name. */
export function chordFromInput (input: KeyInput): Chord | null {
  if (MODIFIER_KEYS.has(input.key)) return null
  let key: string | undefined
  // On Windows a layout's AltGr key arrives as Ctrl and Alt together, and what it typed is text: it is never read by
  // its physical key, or a Polish `ó` would run the command bound to Ctrl+Alt+O and not be typed.
  const byPhysicalKey = !(input.control && input.alt)
  if (input.key in NAMED_KEYS) key = NAMED_KEYS[input.key]
  else if (FUNCTION_KEY.test(input.key)) key = input.key
  // A digit is the same key on every layout; a layout that needs Shift for it
  // types a symbol in `input.key`.
  else if (byPhysicalKey && /^Digit[0-9]$/.test(input.code)) key = input.code.slice(5)
  else if (input.key.length === 1) {
    const lower = input.key.toLowerCase()
    if (isLetter(lower) || isDigit(lower) || SYMBOLS.includes(lower)) key = lower
    // A letter of another alphabet is the letter its physical key has in Latin.
    else if (byPhysicalKey && /^Key[A-Z]$/.test(input.code)) key = input.code.slice(3).toLowerCase()
  }
  return key === undefined ? null : { ctrl: input.control, alt: input.alt, shift: input.shift, meta: input.meta, key }
}

/** Reads `Mod+Shift+T`. Null when the text is not a binding. */
export function parseBinding (text: string, platform: Platform): Chord | null {
  const parts = text.split('+')
  let key = parts.pop() ?? ''
  // The last `+` in "Mod++" is the key itself.
  if (key === '' && parts.at(-1) === '') { parts.pop(); key = '+' }
  const modifiers = new Set(parts)
  if (modifiers.size !== parts.length) return null
  const known = new Set(['Mod', 'Ctrl', 'Alt', 'Shift', 'Meta'])
  if (![...modifiers].every((modifier) => known.has(modifier))) return null
  const normalisedKey = key.length === 1 ? key.toLowerCase() : key
  const valid = isLetter(normalisedKey) || isDigit(normalisedKey) || (normalisedKey.length === 1 && SYMBOLS.includes(normalisedKey)) || NAME_VALUES.has(normalisedKey) || FUNCTION_KEY.test(normalisedKey)
  if (!valid) return null
  const mac = platform === 'darwin'
  return {
    ctrl: modifiers.has('Ctrl') || (modifiers.has('Mod') && !mac),
    alt: modifiers.has('Alt'),
    shift: modifiers.has('Shift'),
    meta: modifiers.has('Meta') || (modifiers.has('Mod') && mac),
    key: normalisedKey
  }
}

/** Written down as a binding, `Mod` for the platform's main modifier. */
export function formatBinding (chord: Chord, platform: Platform): string {
  const mac = platform === 'darwin'
  const mod = mac ? chord.meta && !chord.ctrl : chord.ctrl && !chord.meta
  const parts: string[] = []
  if (mod) parts.push('Mod')
  else {
    if (chord.ctrl) parts.push('Ctrl')
    if (chord.meta) parts.push('Meta')
  }
  if (chord.alt) parts.push('Alt')
  if (chord.shift) parts.push('Shift')
  parts.push(chord.key.length === 1 ? chord.key.toUpperCase() : chord.key)
  return parts.join('+')
}

/** The key caps a person reads: `['Ctrl', 'Shift', 'T']`, or `['Cmd', ...]` on macOS. */
export function displayKeys (chord: Chord, platform: Platform): string[] {
  const mac = platform === 'darwin'
  const keys: string[] = []
  if (chord.ctrl) keys.push('Ctrl')
  if (chord.alt) keys.push(mac ? 'Option' : 'Alt')
  if (chord.shift) keys.push('Shift')
  if (chord.meta) keys.push(mac ? 'Cmd' : 'Meta')
  keys.push(chord.key.length === 1 ? chord.key.toUpperCase() : chord.key)
  return keys
}

/** Whether pressing `pressed` triggers `binding`. Shift is ignored for a symbol
 * that layouts type with and without it (`+`, `=`, ...), so the key that
 * types `+` matches wherever it sits. */
export function matches (pressed: Chord, binding: Chord): boolean {
  if (pressed.key !== binding.key || pressed.ctrl !== binding.ctrl || pressed.alt !== binding.alt || pressed.meta !== binding.meta) return false
  const layoutDependentShift = binding.key.length === 1 && !isLetter(binding.key) && !isDigit(binding.key)
  return layoutDependentShift || pressed.shift === binding.shift
}

/** A stable key for a chord, for looking it up and comparing. */
export function chordId (chord: Chord): string {
  return `${chord.ctrl ? 'c' : ''}${chord.alt ? 'a' : ''}${chord.shift ? 's' : ''}${chord.meta ? 'm' : ''}+${chord.key}`
}
