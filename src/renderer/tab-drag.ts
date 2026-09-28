// Dragging a tab in the strip. Pointer events with the pointer captured, not
// HTML drag and drop: an HTML drag hands its payload to whatever page is under
// the pointer, which could read what was dragged, and pointer capture keeps
// events coming to this view while the pointer is over the page or outside the
// window (measured), which is what lets a tab be dragged out.
//
// A drag has three outcomes. Let go in the strip: the tab takes its new place.
// Let go beyond the strip's reach: the tab goes to another window or a window of
// its own, and main decides which from where on the screen it landed. Escape:
// nothing changes.

/** How far the pointer moves before a press becomes a drag, so a click is still a click. */
export const DRAG_THRESHOLD_PX = 5
/** How far below or above the strip the pointer goes before the tab is taken out of it. */
export const TEAR_DISTANCE_PX = 44

/** The place among the other tabs, whose centres are `centres`, that a tab dragged to `x` takes. */
export function dropIndex (centres: readonly number[], x: number): number {
  let index = 0
  for (const centre of centres) {
    if (x > centre) index += 1
  }
  return index
}

/** Whether the pointer is far enough out of the strip (above or below it, or outside the window) that letting go takes the tab out. */
export function isTornOut (pointer: { x: number, y: number }, view: { width: number, stripHeight: number }): boolean {
  return pointer.y > view.stripHeight + TEAR_DISTANCE_PX || pointer.y < -TEAR_DISTANCE_PX || pointer.x < 0 || pointer.x > view.width
}

export interface TabDragHost {
  /** The strip's tab elements, in order, dragged one included. */
  tabs: () => HTMLElement[]
  /** Where a tab element is put when it is not the last: before this one. Null puts it at the end. */
  beforeLast: () => HTMLElement | null
  stripHeight: () => number
  moveTab: (id: string, index: number) => void
  dropTab: (id: string, screenX: number, screenY: number) => void
  /** The drag is over. `tornOut`: the tab is on its way to another window, so the strip is to go back to what main last said. */
  finished: (tornOut: boolean) => void
}

let dragging = false

/** Whether a drag is under way: the strip is not redrawn under a pointer that has hold of one of its tabs. */
export function isDraggingTab (): boolean {
  return dragging
}

export function makeTabDraggable (el: HTMLElement, id: string, host: TabDragHost): void {
  let start: { x: number, y: number, grab: number, pointerId: number } | null = null
  let active = false

  const end = (tornOut = false): void => {
    if (start !== null && el.hasPointerCapture(start.pointerId)) el.releasePointerCapture(start.pointerId)
    start = null
    const wasActive = active
    active = false
    dragging = false
    el.classList.remove('dragging', 'torn')
    el.style.transform = ''
    if (wasActive) host.finished(tornOut)
  }

  el.addEventListener('pointerdown', (event) => {
    if (event.button !== 0 || (event.target as HTMLElement).closest('.close') !== null) return
    start = { x: event.clientX, y: event.clientY, grab: event.clientX - el.getBoundingClientRect().left, pointerId: event.pointerId }
    el.setPointerCapture(event.pointerId)
  })

  el.addEventListener('pointermove', (event) => {
    if (start === null) return
    if (!active) {
      if (Math.hypot(event.clientX - start.x, event.clientY - start.y) < DRAG_THRESHOLD_PX) return
      active = true
      dragging = true
      el.classList.add('dragging')
    }
    const others = host.tabs().filter((tab) => tab !== el)
    const index = dropIndex(others.map((tab) => { const box = tab.getBoundingClientRect(); return box.left + box.width / 2 }), event.clientX)
    const next = others[index] ?? host.beforeLast()
    if (next === null || next.previousElementSibling !== el) el.parentElement?.insertBefore(el, next)
    el.style.transform = ''
    el.style.transform = `translateX(${String(event.clientX - start.grab - el.getBoundingClientRect().left)}px)`
    el.classList.toggle('torn', isTornOut({ x: event.clientX, y: event.clientY }, { width: window.innerWidth, stripHeight: host.stripHeight() }))
  })

  el.addEventListener('pointerup', (event) => {
    if (start === null) return
    if (!active) {
      end()
      return
    }
    const torn = isTornOut({ x: event.clientX, y: event.clientY }, { width: window.innerWidth, stripHeight: host.stripHeight() })
    const index = host.tabs().indexOf(el)
    // The click that follows a drag must not also activate the tab.
    el.addEventListener('click', (click) => { click.stopImmediatePropagation() }, { capture: true, once: true })
    end(torn)
    if (torn) host.dropTab(id, event.screenX, event.screenY)
    else host.moveTab(id, index)
  })

  el.addEventListener('pointercancel', () => { end(true) })
  window.addEventListener('keydown', (event) => { if (event.key === 'Escape' && active) end(true) })
}
