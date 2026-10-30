// Copying the whole address field hands main the text, so the clipboard gets the address with its web link as well
// (`src/main/os/address-clipboard.ts`; the renderer cannot call it). A part of the field stays the browser's own copy.

/** The longest text main takes (`MAX_PASTED_LENGTH` in `src/main/shell/paste-and-go.ts`): a longer field is copied by the browser. */
export const MAX_COPIED_FIELD = 4096

type Field = Pick<HTMLInputElement, 'value' | 'selectionStart' | 'selectionEnd'>

/** The field's text when the selection takes all of it, and undefined for a caret, a part, an empty field or a text too long for main. */
export function wholeFieldText (field: Field): string | undefined {
  const { value, selectionStart, selectionEnd } = field
  const whole = value !== '' && value.length <= MAX_COPIED_FIELD && selectionStart === 0 && selectionEnd === value.length
  return whole ? value : undefined
}

/** Makes a copy of the whole field a call to main: the browser's own copy is stopped, since main writes the clipboard. */
export function handleAddressCopy (field: Field, event: Pick<Event, 'preventDefault'>, act: (name: string, payload: unknown) => Promise<unknown>): void {
  const text = wholeFieldText(field)
  if (text === undefined) return
  event.preventDefault()
  void act('address.copy', { text })
}
