// The panes the keyboard cycles through, and which one comes next. Pure: the
// runner that moves focus is ./pane-cycle.ts.

/** In reading order. `address` stands for the whole chrome wherever the order is seen from outside it. */
export const PANE_ORDER = ['address', 'toolbar', 'tabs', 'bookmarks', 'side-panel', 'page'] as const

export type PaneName = typeof PANE_ORDER[number]

const CHROME_PANES: readonly PaneName[] = ['address', 'toolbar', 'tabs', 'bookmarks']

export const isChromePane = (name: PaneName): boolean => CHROME_PANES.includes(name)

/** The chrome's own panes among `available`, in order. */
export function chromePanes (available: readonly PaneName[]): PaneName[] {
  return CHROME_PANES.filter((name) => available.includes(name))
}

/**
 * The pane after (`1`) or before (`-1`) `current`, wrapping at both ends, among the `available` ones. A `current`
 * that is not available (the chrome's last pane, say, seen from a list that holds it as one) lands on the
 * available pane next to where it would sit. Null when nothing is available.
 */
export function nextPane (current: PaneName, available: readonly PaneName[], direction: 1 | -1): PaneName | null {
  const ordered = PANE_ORDER.filter((name) => available.includes(name))
  if (ordered.length === 0) return null
  const at = ordered.indexOf(current)
  if (at >= 0) return ordered[(at + direction + ordered.length) % ordered.length] ?? null
  const position = PANE_ORDER.indexOf(current)
  const after = ordered.findIndex((name) => PANE_ORDER.indexOf(name) > position)
  if (direction === 1) return ordered[after < 0 ? 0 : after] ?? null
  return ordered[(after < 0 ? ordered.length : after) - 1] ?? ordered.at(-1) ?? null
}
