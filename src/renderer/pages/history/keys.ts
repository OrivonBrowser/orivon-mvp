// What a key does on the History page, decided apart from the document so each case can be tested. The page
// carries the intent out.
import type { Step } from '../shared/list-selection.js'

export type Intent =
  | { readonly kind: 'move', readonly to: Step, readonly extend: boolean }
  | { readonly kind: 'open', readonly disposition: 'tab' | 'background' }
  | { readonly kind: 'toggle' }
  | { readonly kind: 'all' }
  | { readonly kind: 'delete' }
  | { readonly kind: 'escape' }
  | { readonly kind: 'search' }

export interface KeyFacts {
  readonly key: string
  readonly ctrlKey: boolean
  readonly metaKey: boolean
  readonly shiftKey: boolean
  readonly altKey: boolean
  /** The focus is in a text field, which keeps its own keys. */
  readonly inField: boolean
  /** The focus is on a row itself, not on a button inside it. */
  readonly onRow: boolean
  readonly mac: boolean
}

const MOVES: Readonly<Record<string, Step>> = { ArrowUp: 'up', ArrowDown: 'down', Home: 'first', End: 'last' }

export function intentFor (facts: KeyFacts): Intent | null {
  const { key, shiftKey, altKey, inField, onRow, mac } = facts
  const mod = mac ? facts.metaKey : facts.ctrlKey
  if (key === 'Escape') return { kind: 'escape' }
  if (inField || altKey) return null
  if (key === '/' && !facts.ctrlKey && !facts.metaKey) return { kind: 'search' }
  if ((key === 'a' || key === 'A') && mod && !shiftKey) return { kind: 'all' }
  if (!onRow) return null
  if (key === 'Enter') return { kind: 'open', disposition: mod ? 'background' : 'tab' }
  if (facts.ctrlKey || facts.metaKey) return null
  const move = MOVES[key]
  if (move !== undefined) return { kind: 'move', to: move, extend: shiftKey }
  if (key === ' ') return { kind: 'toggle' }
  if (key === 'Delete' || (mac && key === 'Backspace')) return { kind: 'delete' }
  return null
}
