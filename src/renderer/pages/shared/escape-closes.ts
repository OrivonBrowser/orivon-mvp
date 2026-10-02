export interface KeyEventLike {
  readonly key: string
  readonly defaultPrevented: boolean
  readonly ctrlKey: boolean
  readonly altKey: boolean
  readonly metaKey: boolean
  readonly shiftKey: boolean
  readonly isComposing: boolean
}

export interface KeyTarget {
  addEventListener: (type: 'keydown', listener: (event: KeyEventLike) => void) => void
}

/** Closes a toolbar popup on a plain Escape the page did not take. Listens in the page, not in main: an open native
 * `<select>` consumes its own Escape before the document sees it, and a main-side key hook would take it first. */
export function closeOnEscape (target: KeyTarget, close: () => void): void {
  target.addEventListener('keydown', (event) => {
    if (event.key !== 'Escape' || event.defaultPrevented || event.isComposing) return
    if (event.ctrlKey || event.altKey || event.metaKey || event.shiftKey) return
    close()
  })
}
