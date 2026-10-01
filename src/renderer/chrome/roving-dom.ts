// Gives a row of controls one Tab stop and the arrow keys: the stop is the item that last had focus, and the
// other items leave the Tab order. Wired by event delegation on the row's container, so a row that is rebuilt
// (the tab strip) needs no wiring again.
import { isRovingKey, rovingTarget } from './roving.js'

export interface RovingRow {
  /** The row's container: it hears the keys. */
  readonly root: HTMLElement
  /** The items in visual order, hidden ones left out. Read on every key and every sync. */
  items: () => HTMLElement[]
  /** Called with the item that took focus from an arrow key. */
  moved?: (item: HTMLElement) => void
  /** Keys of the row's own (Enter, Delete): true when handled. The item is the one holding focus. */
  keys?: (event: KeyboardEvent, item: HTMLElement) => boolean
}

export const canFocus = (el: HTMLElement): boolean => !(el as Partial<HTMLButtonElement>).disabled && el.getClientRects().length > 0

/** Makes `stop` the row's one Tab stop, or the first item that can take focus when `stop` is not one. */
export function syncStops (items: readonly HTMLElement[], stop: HTMLElement | null | undefined): HTMLElement | undefined {
  const chosen = stop !== undefined && stop !== null && items.includes(stop) && canFocus(stop) ? stop : items.find(canFocus)
  for (const item of items) item.tabIndex = item === chosen ? 0 : -1
  return chosen
}

export function attachRoving (row: RovingRow): void {
  row.root.addEventListener('keydown', (event) => {
    if (event.defaultPrevented || event.altKey || event.ctrlKey || event.metaKey) return
    const items = row.items()
    const target = event.target instanceof Node ? event.target : null
    const at = items.findIndex((item) => item === target || (target !== null && item.contains(target) && !(target instanceof HTMLInputElement)))
    const current = items[at]
    if (current === undefined) return
    // A text field inside the row keeps its own arrow keys.
    if (target instanceof HTMLInputElement || target instanceof HTMLTextAreaElement) return
    if (row.keys?.(event, current) === true) {
      event.preventDefault()
      return
    }
    if (event.shiftKey || !isRovingKey(event.key)) return
    event.preventDefault()
    const next = items[rovingTarget(items.map(canFocus), at, event.key)]
    if (next === undefined || next === current) return
    next.focus()
    row.moved?.(next)
  })
}
