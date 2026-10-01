// What a key does in the manager's list and tree, decided apart from the document so each case can be tested. The
// page carries the intent out.
import type { Step } from '../shared/list-selection.js'

export type ListIntent =
  | { readonly kind: 'move', readonly to: Step, readonly extend: boolean }
  | { readonly kind: 'all' }
  | { readonly kind: 'open', readonly background: boolean }
  | { readonly kind: 'parent' }
  | { readonly kind: 'edit' }
  | { readonly kind: 'delete' }
  | { readonly kind: 'nudge', readonly direction: 'up' | 'down' }
  | { readonly kind: 'toggle' }
  | { readonly kind: 'menu' }
  | { readonly kind: 'search' }
  | { readonly kind: 'escape' }

export interface KeyFacts {
  readonly key: string
  readonly ctrlKey: boolean
  readonly metaKey: boolean
  readonly shiftKey: boolean
  readonly altKey: boolean
  /** The focus is in a text field, which keeps its own keys. */
  readonly inField: boolean
  readonly mac: boolean
}

const MOVES: Readonly<Record<string, Step>> = { ArrowUp: 'up', ArrowDown: 'down', Home: 'first', End: 'last' }

/** The key pressed while a row of the list has the focus; null when the list does not want it. */
export function listIntent (facts: KeyFacts): ListIntent | null {
  const { key, shiftKey, altKey, inField, mac } = facts
  const mod = mac ? facts.metaKey : facts.ctrlKey
  if (key === 'Escape') return { kind: 'escape' }
  if (inField) return null
  if (key === '/' && !facts.ctrlKey && !facts.metaKey && !altKey) return { kind: 'search' }
  if (altKey && !mod && !shiftKey) {
    if (key === 'ArrowLeft') return { kind: 'parent' }
    if (key === 'ArrowUp') return { kind: 'nudge', direction: 'up' }
    if (key === 'ArrowDown') return { kind: 'nudge', direction: 'down' }
    return null
  }
  if (altKey) return null
  if ((key === 'a' || key === 'A') && mod && !shiftKey) return { kind: 'all' }
  if (key === 'ContextMenu' || (key === 'F10' && shiftKey)) return { kind: 'menu' }
  if (key === 'Enter') return { kind: 'open', background: mod }
  if (key === 'F2') return { kind: 'edit' }
  if (key === 'Backspace') return mod && mac ? { kind: 'delete' } : mod ? null : { kind: 'parent' }
  if (key === 'Delete') return { kind: 'delete' }
  if (facts.ctrlKey || facts.metaKey) return null
  const move = MOVES[key]
  if (move !== undefined) return { kind: 'move', to: move, extend: shiftKey }
  if (key === ' ') return { kind: 'toggle' }
  return null
}

export type TreeIntent =
  | { readonly kind: 'move', readonly to: Step }
  | { readonly kind: 'right' }
  | { readonly kind: 'left' }
  | { readonly kind: 'select' }

/** The key pressed while a folder of the tree has the focus. */
export function treeIntent (key: string, modified: boolean): TreeIntent | null {
  if (modified) return null
  const move = MOVES[key]
  if (move !== undefined) return { kind: 'move', to: move }
  if (key === 'ArrowRight') return { kind: 'right' }
  if (key === 'ArrowLeft') return { kind: 'left' }
  if (key === 'Enter' || key === ' ') return { kind: 'select' }
  return null
}
