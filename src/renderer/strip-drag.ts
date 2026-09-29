// The empty tail of the tab strip, after the new-tab button, in the manual
// drag mode drag-mode.ts's `dragModeFor` picks for Linux/X11 (main tells the
// chrome which mode through the preload's `dragMode`; see main.ts). In the
// other mode the tail is plain `-webkit-app-region: drag` content and none of
// this runs -- see index.html and styles/tabstrip.css.
//
// Pointer events, not a native drag region: a real caption click there is
// eaten by Chromium's own window-event filter under X11 (measured), so a
// middle click, a double click and a left-button drag are all read here and
// turned into commands for main to act on instead.
import { DRAG_THRESHOLD_PX } from './tab-drag.js'

export interface StripDragHost {
  newTab: () => void
  toggleMaximize: () => void
  moveStart: (x: number, y: number) => void
  moveTo: (x: number, y: number) => void
  moveEnd: (x: number, y: number) => void
  /** The drag ended in a `pointercancel`, not a release: its coordinates can be 0,0, nowhere the
   * pointer actually was, so the move ends here with no edge-snap action, unlike `moveEnd`. */
  moveCancel: () => void
}

export function makeStripDraggable (el: HTMLElement, host: StripDragHost): void {
  // Windows arms Blink's middle-click autoscroll on mousedown, before
  // 'auxclick' fires -- preventDefault() there alone is too late on that
  // platform (main.ts's own tab middle-click handler has the same guard).
  el.addEventListener('mousedown', (event) => { if (event.button === 1) event.preventDefault() })
  el.addEventListener('auxclick', (event) => {
    if (event.button !== 1) return
    event.preventDefault()
    host.newTab()
  })
  el.addEventListener('dblclick', (event) => { if (event.button === 0) host.toggleMaximize() })

  let start: { x: number, y: number, pointerId: number } | null = null
  let dragging = false

  el.addEventListener('pointerdown', (event) => {
    if (event.button !== 0) return
    start = { x: event.screenX, y: event.screenY, pointerId: event.pointerId }
    el.setPointerCapture(event.pointerId)
  })

  el.addEventListener('pointermove', (event) => {
    if (start === null) return
    if (!dragging) {
      if (Math.hypot(event.screenX - start.x, event.screenY - start.y) < DRAG_THRESHOLD_PX) return
      dragging = true
      host.moveStart(start.x, start.y)
    }
    host.moveTo(event.screenX, event.screenY)
  })

  const end = (event: PointerEvent, cancelled: boolean): void => {
    if (start === null) return
    if (dragging) { if (cancelled) host.moveCancel(); else host.moveEnd(event.screenX, event.screenY) }
    if (el.hasPointerCapture(start.pointerId)) el.releasePointerCapture(start.pointerId)
    start = null
    dragging = false
  }
  el.addEventListener('pointerup', (event) => { end(event, false) })
  el.addEventListener('pointercancel', (event) => { end(event, true) })
}
