// What a key or an input event in the address field means for the dropdown, apart from the DOM it arrives in.
// `address-suggest.ts` reads the events and does what these answer.

export interface KeyLike {
  key: string
  altKey: boolean
  ctrlKey: boolean
  metaKey: boolean
  shiftKey: boolean
  isComposing?: boolean
}

export type KeyIntent =
  | { type: 'move', step: 1 | -1 }
  /** Go to the selected row: `tab` opens it in a new foreground tab. */
  | { type: 'pick', disposition: 'current' | 'tab' }
  | { type: 'escape' }

export interface DropdownState {
  /** The rows are showing. */
  open: boolean
  /** The selected row, 0 being the first. */
  selected: number
}

const plain = (key: KeyLike): boolean => !key.altKey && !key.ctrlKey && !key.metaKey && !key.shiftKey

/** What to do for a key pressed in the field, or null to let the field have it. Enter on the first row is left
 * to the form's own submit, which is what it always did. */
export function keyIntent (key: KeyLike, state: DropdownState): KeyIntent | null {
  if (key.isComposing === true) return null
  switch (key.key) {
    case 'ArrowDown': return state.open && plain(key) ? { type: 'move', step: 1 } : null
    case 'ArrowUp': return state.open && plain(key) ? { type: 'move', step: -1 } : null
    case 'Enter':
      if (!state.open) return null
      if (key.altKey && !key.ctrlKey && !key.metaKey) return { type: 'pick', disposition: 'tab' }
      return plain(key) && state.selected >= 1 ? { type: 'pick', disposition: 'current' } : null
    case 'Escape': return plain(key) ? { type: 'escape' } : null
    default: return null
  }
}

/** A key that puts one character in the field. */
export const isPrintableKey = (key: KeyLike): boolean => key.key.length === 1 && !key.ctrlKey && !key.metaKey && !key.altKey

/** How long after a printable key an insertion still counts as that key's own. A fill or a paste has no such key. */
export const TYPED_WITHIN_MS = 100

export interface InputLike { inputType: string, isComposing: boolean }
export interface FieldLike { value: string, selectionStart: number | null, selectionEnd: number | null }

/** Whether the field just received a character the person typed, at its end: the only input the text may be
 * finished after. A paste, a fill, a deletion and the middle of the text are not. */
export function wasTyped (event: InputLike, field: FieldLike, lastPrintableKeyAt: number, now: number): boolean {
  if (event.inputType !== 'insertText' || event.isComposing) return false
  if (now - lastPrintableKeyAt > TYPED_WITHIN_MS) return false
  return field.selectionStart === field.value.length && field.selectionEnd === field.value.length
}
