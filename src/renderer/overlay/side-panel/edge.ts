// The resize edge on the page side of the panel: a separator the pointer drags and the arrow keys move.
// A drag keeps its pointer captured, so moves keep arriving over the page's own view; positions are screen
// coordinates, which do not change as the panel's view moves under the pointer.
import { h } from '../../pages/shared/dom.js'
import { widthFromDrag, widthFromKey } from './resize.js'
import type { Limits, Side } from './resize.js'

/** How long after the last key an answer from main is trusted over the width the keys asked for. */
const KEY_SETTLE_MS = 400

export interface Edge {
  readonly el: HTMLElement
  update: (state: { side: Side, width: number, limits: Limits }) => void
}

export function createEdge (resize: (width: number) => void, root: HTMLElement): Edge {
  const el = h('div', { className: 'sp-edge', ariaLabel: 'Resize side panel', title: 'Drag to resize; double-click to reset' })
  el.setAttribute('role', 'separator')
  el.setAttribute('aria-orientation', 'vertical')
  el.tabIndex = 0
  let side: Side = 'right'
  let width = 0
  let limits: Limits = { min: 0, max: 0, reset: 0 }
  let drag: { startX: number, startWidth: number } | null = null
  let frame = 0
  let latest = 0
  // The width the last key asked for, until main has caught up: an answer to an earlier press must not undo a later one.
  let wanted: number | null = null
  let settle: ReturnType<typeof setTimeout> | undefined

  function show (): void {
    el.setAttribute('aria-valuenow', String(wanted ?? width))
    el.setAttribute('aria-valuemin', String(limits.min))
    el.setAttribute('aria-valuemax', String(limits.max))
  }

  // One request a frame while dragging: main applies at most one layout per turn anyway.
  function send (next: number): void {
    latest = next
    if (frame !== 0) return
    frame = requestAnimationFrame(() => { frame = 0; resize(latest) })
  }

  el.addEventListener('pointerdown', (event) => {
    if (event.button !== 0) return
    event.preventDefault()
    el.setPointerCapture(event.pointerId)
    drag = { startX: event.screenX, startWidth: width }
    root.classList.add('is-dragging')
  })
  el.addEventListener('pointermove', (event) => {
    if (drag === null) return
    send(widthFromDrag(drag.startWidth, drag.startX, event.screenX, side, limits))
  })
  const end = (event: PointerEvent): void => {
    if (drag === null) return
    drag = null
    root.classList.remove('is-dragging')
    if (el.hasPointerCapture(event.pointerId)) el.releasePointerCapture(event.pointerId)
  }
  el.addEventListener('pointerup', end)
  el.addEventListener('pointercancel', end)
  el.addEventListener('dblclick', () => { resize(limits.reset) })
  el.addEventListener('keydown', (event) => {
    if (event.altKey || event.ctrlKey || event.metaKey) return
    const next = widthFromKey(event.key, wanted ?? width, side, limits)
    if (next === null) return
    event.preventDefault()
    wanted = next
    clearTimeout(settle)
    settle = setTimeout(() => { wanted = null; show() }, KEY_SETTLE_MS)
    show()
    resize(next)
  })

  return {
    el,
    update (state) {
      side = state.side
      width = state.width
      limits = state.limits
      if (wanted === state.width) wanted = null
      show()
    }
  }
}
