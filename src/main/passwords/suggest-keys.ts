// What the arrow keys, Enter and Escape do to the chooser that opens under a focused box. That chooser never
// holds the keyboard, because the person is typing in the page, so main reads the keys before the page does
// and decides here whether the chooser takes one. Pure: no `electron` import.

export type SuggestAction = 'pass' | 'move' | 'choose' | 'dismiss'

export interface SuggestStep { selected: number, action: SuggestAction }

/** `selected` is -1 while no row is chosen; Enter then belongs to the page, so a form can still be submitted. */
export function suggestKey (count: number, selected: number, key: string): SuggestStep {
  if (count <= 0) return { selected, action: 'pass' }
  switch (key) {
    case 'ArrowDown':
      return { selected: Math.min(count - 1, selected + 1), action: 'move' }
    case 'ArrowUp':
      return { selected: selected === -1 ? count - 1 : Math.max(0, selected - 1), action: 'move' }
    case 'Enter':
      return { selected, action: selected >= 0 ? 'choose' : 'pass' }
    case 'Escape':
      return { selected, action: 'dismiss' }
    default:
      return { selected, action: 'pass' }
  }
}

/** Keys the chooser may take: anything else is never read. */
export const SUGGEST_KEYS: ReadonlySet<string> = new Set(['ArrowDown', 'ArrowUp', 'Enter', 'Escape'])
