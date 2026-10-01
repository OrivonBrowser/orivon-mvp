// How the menu writes a shortcut, and which row an arrow key reaches. Both are
// plain functions so they are tested without a document.

const MAC_KEYS: Readonly<Record<string, string>> = { Ctrl: '⌃', Option: '⌥', Shift: '⇧', Cmd: '⌘' }

/** `['Ctrl', 'Shift', 'T']` as `Ctrl+Shift+T`, or as the key symbols a Mac shows, run together. */
export function formatKeys (keys: readonly string[], platform: string): string {
  if (platform !== 'darwin') return keys.join('+')
  return keys.map((key) => MAC_KEYS[key] ?? key).join('')
}

export type NavKey = 'ArrowDown' | 'ArrowUp' | 'Home' | 'End'

/** The row an arrow key moves to; from no row, Down and Home reach the first and Up and End the last. Wraps at both ends. */
export function nextRow (count: number, at: number, key: NavKey): number {
  if (count <= 0) return -1
  if (key === 'Home') return 0
  if (key === 'End') return count - 1
  if (at < 0) return key === 'ArrowDown' ? 0 : count - 1
  return key === 'ArrowDown' ? (at + 1) % count : (at - 1 + count) % count
}
