export interface MouseUpTarget {
  addEventListener: (type: 'mouseup', listener: (event: MouseUpEventLike) => void, capture?: boolean) => void
}

export interface MouseUpEventLike {
  readonly button: number
  readonly target: unknown
  preventDefault: () => void
}

/** Whether a click on this element lands in text the person can edit: a field there takes the middle-click paste. */
export function isEditableTarget (target: unknown): boolean {
  const el = target as { tagName?: unknown, isContentEditable?: unknown } | null
  if (el === null || typeof el !== 'object') return false
  if (el.isContentEditable === true) return true
  return el.tagName === 'INPUT' || el.tagName === 'TEXTAREA'
}

/**
 * Stops a middle-button release from pasting the Linux selection into whatever field holds focus. Blink does that
 * paste on the release unless it is default-prevented, and a middle-click here closes a tab or opens a row, so the
 * paste would land in the address bar or a search box first. A release over a field is left alone: that is the
 * paste the person asked for. Installed once per document, in the capture phase.
 */
export function guardMiddleClickPaste (target: MouseUpTarget): void {
  target.addEventListener('mouseup', (event) => {
    if (event.button === 1 && !isEditableTarget(event.target)) event.preventDefault()
  }, true)
}
