// When the address field selects its whole text, apart from the DOM events that drive it. `address-display.ts`
// feeds it the field's events and acts on what it answers.

/** Selects the address on an entry (Tab, a shortcut, the first press) and leaves a refocus alone: when the window
 * regains the keyboard the field is still the document's active element, and its caret stays where it was. */
export interface AddressSelect {
  /** The field lost the keyboard; `stillActive` is whether it is still the document's active element (the window blurred). */
  blur: (stillActive: boolean) => void
  /** The field gained the keyboard. True: select everything now. */
  focus: () => boolean
  /** A press began on the field; `fieldActive` is whether it was already the active element. */
  pointerDown: (fieldActive: boolean) => void
  /** The press ended; `dragged` is whether the pointer moved far enough to be dragging out a range. True: select everything now. */
  pointerUp: (dragged: boolean) => boolean
  /** A key was pressed in the field. */
  keyDown: () => void
}

export function createAddressSelect (): AddressSelect {
  // The window took the keyboard while the field kept its place as the active element.
  let kept = false
  let pressPending = false
  let firstPress = false
  return {
    blur: (stillActive) => { kept = stillActive },
    focus: () => !kept && !pressPending,
    pointerDown: (fieldActive) => {
      pressPending = true
      firstPress = !fieldActive || kept
      kept = false
    },
    pointerUp: (dragged) => {
      const wanted = pressPending && firstPress && !dragged
      pressPending = false
      firstPress = false
      return wanted
    },
    keyDown: () => { kept = false }
  }
}
