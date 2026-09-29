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
/** How far below or above the strip the pointer goes before the tab is taken out of it. Owner-reported: 44px
 * read as "hard to get the tab out of the strip with the mouse" -- shrunk so a small, deliberate downward
 * movement tears a tab loose, rather than needing a long drag past most of a toolbar's height. */
export const TEAR_DISTANCE_PX = 18

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
  /** The tab joined to this one in a split, which is dragged along with it. */
  partnerOf: (el: HTMLElement) => HTMLElement | null
  stripHeight: () => number
  moveTab: (id: string, index: number) => void
  /** A genuine drag just started (the press moved past the threshold) -- lets main start capturing the
   * tab's page early, for the floating preview a tear-off shows if this drag goes that far. */
  dragStarted: (id: string) => void
  /** The pointer is outside the strip's own reach (torn out, tab-drag.ts's own `isTornOut`), at this place
   * of the window; no place: it is back inside the strip. */
  hover: (id: string, x?: number, y?: number) => void
  dropTab: (id: string, screenX: number, screenY: number, clientX: number, clientY: number) => void
  /** The drag is over. `tornOut`: the tab is on its way to another window, so the strip is to go back to what main last said. */
  finished: (tornOut: boolean) => void
  /** The drag has genuinely ended -- dropped in the strip, torn out, or cancelled -- distinct from
   * `hover(id)`'s own "back inside the strip" signal, which also fires on every in-strip move of a
   * drag that is still under way. Releases the capture `dragStarted` began. */
  dragEnded: () => void
}

let dragging = false
/** A tab is pressed and may yet be dragged or clicked. */
let pressed = false
/** Ends the drag under way, for Escape; one listener serves every tab. */
let cancelDrag: (() => void) | null = null
let listeningForEscape = false

/** Whether a tab is held: the strip is not redrawn under a pointer that has hold of one of its tabs, or the click that
 * follows would go to an element that is no longer there. */
export function isDraggingTab (): boolean {
  return dragging || pressed
}

function listenForEscape (): void {
  if (listeningForEscape) return
  listeningForEscape = true
  window.addEventListener('keydown', (event) => { if (event.key === 'Escape') cancelDrag?.() })
  // A press whose element was taken away never reaches its own end: the pointer going up anywhere frees the strip.
  for (const type of ['pointerup', 'pointercancel']) {
    window.addEventListener(type, () => { setTimeout(() => { if (!dragging) pressed = false }, 0) }, true)
  }
}

export function makeTabDraggable (el: HTMLElement, id: string, host: TabDragHost): void {
  listenForEscape()
  let start: { x: number, grab: number, pointerId: number, y: number } | null = null
  let active = false
  /** The tabs that move together: this one, and the one it is joined to, in the strip's order. */
  let group: HTMLElement[] = [el]
  /** The other tabs, and where they sit before anything moves. */
  let others: HTMLElement[] = []
  let natural: DOMRect[] = []
  let elLeft = 0
  let groupWidth = 0
  let firstAt = 0
  let target = 0

  const clear = (): void => {
    for (const tab of [...group, ...others]) {
      tab.style.transform = ''
      tab.style.transition = ''
    }
  }

  /** `redraw` is false for a drop in the strip that moved the tab: main's word about the new order is on its way,
   * and drawing the old order first would flash it. */
  const end = (tornOut = false, redraw = true): void => {
    if (start !== null && el.hasPointerCapture(start.pointerId)) el.releasePointerCapture(start.pointerId)
    start = null
    const wasActive = active
    active = false
    dragging = false
    pressed = false
    cancelDrag = null
    for (const member of group) member.classList.remove('dragging', 'torn')
    clear()
    if (wasActive) {
      host.hover(id)
      host.dragEnded()
      if (redraw) host.finished(tornOut)
    } else {
      // After the click that follows a press: redrawn now, it would have no tab to land on.
      setTimeout(() => { host.finished(false) }, 0)
    }
  }

  // The strip is never rearranged while the pointer holds a tab: moving the element that has the
  // pointer captured releases the capture and the drop would go astray. Tabs slide out of the way
  // instead, and the strip is redrawn from main's word once the tab is let go.
  const begin = (): void => {
    const all = host.tabs()
    others = all.filter((tab) => !group.includes(tab))
    natural = others.map((tab) => tab.getBoundingClientRect())
    elLeft = el.getBoundingClientRect().left
    const rects = group.map((member) => member.getBoundingClientRect())
    groupWidth = Math.max(...rects.map((rect) => rect.right)) - Math.min(...rects.map((rect) => rect.left))
    firstAt = all.indexOf(group[0] ?? el)
    target = firstAt
    active = true
    dragging = true
    cancelDrag = () => { end(true) }
    for (const member of group) member.classList.add('dragging')
    host.dragStarted(id)
  }

  el.addEventListener('pointerdown', (event) => {
    if (event.button !== 0 || (event.target as HTMLElement).closest('.close') !== null) return
    start = { x: event.clientX, y: event.clientY, grab: event.clientX - el.getBoundingClientRect().left, pointerId: event.pointerId }
    const partner = host.partnerOf(el)
    group = partner === null ? [el] : host.tabs().filter((tab) => tab === el || tab === partner)
    pressed = true
    el.setPointerCapture(event.pointerId)
  })

  el.addEventListener('pointermove', (event) => {
    if (start === null) return
    if (!active) {
      if (Math.hypot(event.clientX - start.x, event.clientY - start.y) < DRAG_THRESHOLD_PX) return
      begin()
    }
    target = dropIndex(natural.map((box) => box.left + box.width / 2), event.clientX)
    const offset = event.clientX - start.grab - elLeft
    const torn = isTornOut({ x: event.clientX, y: event.clientY }, { width: window.innerWidth, stripHeight: host.stripHeight() })
    for (const member of group) {
      member.style.transform = `translateX(${String(offset)}px)`
      member.classList.toggle('torn', torn)
    }
    others.forEach((tab, at) => {
      // A tab the dragged ones have passed makes room on the side they left.
      const shift = at < firstAt && at >= target ? groupWidth : at >= firstAt && at < target ? -groupWidth : 0
      tab.style.transition = 'transform 120ms ease'
      tab.style.transform = shift === 0 ? '' : `translateX(${String(shift)}px)`
    })
    // Once the tab is torn out, main shows where letting go would land it: a split edge on its own
    // window's page, another window's strip (the cross-window mark), or a window of its own. Matches
    // `torn` above exactly, so the same movement that dims the tab is what starts showing this.
    if (torn) host.hover(id, event.clientX, event.clientY)
    else host.hover(id)
  })

  el.addEventListener('pointerup', (event) => {
    if (start === null) return
    if (!active) {
      end()
      return
    }
    const torn = isTornOut({ x: event.clientX, y: event.clientY }, { width: window.innerWidth, stripHeight: host.stripHeight() })
    const index = target
    // The click that follows a drag must not also activate the tab.
    el.addEventListener('click', (click) => { click.stopImmediatePropagation() }, { capture: true, once: true })
    end(torn, torn || index === firstAt)
    if (torn) host.dropTab(id, event.screenX, event.screenY, event.clientX, event.clientY)
    else host.moveTab(id, index)
  })

  el.addEventListener('pointercancel', () => { end(true) })
}
