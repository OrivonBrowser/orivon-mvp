// Reordering the bookmarks bar by dragging. Pointer events with the pointer captured, never HTML drag and drop:
// an HTML drag hands its payload to whatever page is under the pointer. Past a few pixels a press becomes a drag
// with a mark between items; letting go reorders, letting go over a folder files the item in it, and Escape
// changes nothing.
import { dropPosition } from './bar-overflow.js'

/** How far the pointer moves before a press is a drag, so a click is still a click. */
export const BAR_DRAG_THRESHOLD_PX = 4
/** The middle share of a folder's width where a drop files into it rather than beside it. */
const INTO_SHARE = 0.5

export interface BarDragHost {
  /** The items that are showing, in order: the held one included. */
  items: () => HTMLElement[]
  /** The 2px line that shows where a drop lands. */
  mark: () => HTMLElement
  idOf: (el: HTMLElement) => string
  isFolder: (el: HTMLElement) => boolean
  /** `index` is a position in the bar's list as it stands, the held item included. */
  reorder: (id: string, index: number) => void
  fileInto: (id: string, folder: string) => void
}

type Drop = { into: HTMLElement } | { at: number }

let held = false
let cancel: (() => void) | null = null
let listening = false

/** Whether an item is held: the bar is not redrawn under a pointer that has hold of one. */
export function isDraggingBarItem (): boolean {
  return held
}

function listenForEscape (): void {
  if (listening) return
  listening = true
  window.addEventListener('keydown', (event) => { if (event.key === 'Escape') cancel?.() })
}

export function makeBarDraggable (el: HTMLElement, host: BarDragHost): void {
  listenForEscape()
  let start: { x: number, y: number, id: number } | null = null
  let active = false
  let drop: Drop | null = null
  let folderHit: HTMLElement | null = null
  /** Escape ended the drag with the button still down: the release must not click the item. */
  let cancelled = false

  const clear = (): void => {
    host.mark().hidden = true
    folderHit?.classList.remove('drop-into')
    folderHit = null
    el.classList.remove('dragging')
  }

  const end = (): void => {
    if (start !== null && el.hasPointerCapture(start.id)) el.releasePointerCapture(start.id)
    start = null
    active = false
    drop = null
    held = false
    cancel = null
    clear()
  }

  const locate = (x: number): Drop => {
    const items = host.items()
    const rects = items.map((item) => item.getBoundingClientRect())
    for (const [index, rect] of rects.entries()) {
      const item = items[index] as HTMLElement
      if (item === el || !host.isFolder(item)) continue
      const margin = rect.width * (1 - INTO_SHARE) / 2
      if (x > rect.left + margin && x < rect.right - margin) return { into: item }
    }
    return { at: dropPosition(rects.map((rect) => rect.left + rect.width / 2), x) }
  }

  const show = (target: Drop): void => {
    const mark = host.mark()
    folderHit?.classList.remove('drop-into')
    folderHit = null
    if ('into' in target) {
      mark.hidden = true
      folderHit = target.into
      folderHit.classList.add('drop-into')
      return
    }
    const items = host.items()
    const bar = mark.offsetParent?.getBoundingClientRect()
    const edge = target.at < items.length
      ? (items[target.at] as HTMLElement).getBoundingClientRect().left - 2
      : (items[items.length - 1]?.getBoundingClientRect().right ?? 0) + 1
    mark.style.left = `${String(Math.round(edge - (bar?.left ?? 0)))}px`
    mark.hidden = false
  }

  el.addEventListener('pointerdown', (event) => {
    if (event.button !== 0) return
    cancelled = false
    start = { x: event.clientX, y: event.clientY, id: event.pointerId }
  })

  el.addEventListener('pointermove', (event) => {
    if (start === null) return
    // The press was let go somewhere this item never heard of (it is only captured once a drag begins), so what moves
    // now is a hover, and must not begin a drag.
    if ((event.buttons & 1) === 0) {
      if (active) cancel?.()
      else start = null
      return
    }
    if (!active) {
      if (Math.hypot(event.clientX - start.x, event.clientY - start.y) < BAR_DRAG_THRESHOLD_PX) return
      active = true
      held = true
      cancel = () => { cancelled = true; end() }
      el.setPointerCapture(start.id)
      el.classList.add('dragging')
    }
    drop = locate(event.clientX)
    show(drop)
  })

  el.addEventListener('pointerup', () => {
    const made = active ? drop : null
    const id = host.idOf(el)
    const swallowClick = active || cancelled
    cancelled = false
    end()
    if (swallowClick) {
      // The click that follows a drag must not open the item; if none follows, the guard goes with this turn.
      const swallow = (event: Event): void => { event.stopImmediatePropagation(); event.preventDefault() }
      el.addEventListener('click', swallow, { capture: true, once: true })
      setTimeout(() => { el.removeEventListener('click', swallow, { capture: true }) }, 50)
    }
    if (made === null) return
    if ('into' in made) host.fileInto(id, host.idOf(made.into))
    else host.reorder(id, made.at)
  })

  el.addEventListener('pointercancel', end)
}
