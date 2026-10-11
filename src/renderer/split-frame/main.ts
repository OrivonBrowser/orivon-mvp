// The backdrop of a split: draws what main says (the divider, the ring round the
// pane in use, the place a dragged tab would go) and turns dragging the divider
// into a place along the window. Which ratio that is, and whether it is allowed,
// is main's to say.
import type { FrameState } from '../../main/shell/split-controller.js'

interface OrivonSplit {
  onState: (listener: (state: FrameState) => void) => () => void
  drag: (at: number) => void
  reset: () => void
}

declare global {
  interface Window {
    orivonSplit?: OrivonSplit
  }
}

function element (id: string): HTMLElement {
  const found = document.getElementById(id)
  if (found === null) throw new Error(`#${id} missing`)
  return found
}

const split = window.orivonSplit
if (split === undefined) throw new Error('orivonSplit not exposed -- preload did not run')
const outline = element('outline')
const placeholder = element('placeholder')
const divider = element('divider')

/** How much larger than a pane its ring is: the pane's margin less the ring's own width. */
const RING = 2

let current: FrameState | null = null

/** Puts `element` where `rect` (in window coordinates) is, in the coordinates of this view, which starts at `origin`. */
function place (element: HTMLElement, rect: { x: number, y: number, width: number, height: number }, origin: { x: number, y: number }, grow = 0): void {
  element.style.left = `${String(rect.x - origin.x - grow)}px`
  element.style.top = `${String(rect.y - origin.y - grow)}px`
  element.style.width = `${String(rect.width + 2 * grow)}px`
  element.style.height = `${String(rect.height + 2 * grow)}px`
}

function draw (state: FrameState): void {
  current = state
  const origin = state.area
  const active = state.active === null || state.panes === null ? null : state.panes[state.active]
  outline.hidden = active === null
  if (active !== null) place(outline, active, origin, RING)
  placeholder.hidden = state.placeholder === null
  if (state.placeholder !== null) place(placeholder, state.placeholder, origin)
  divider.hidden = state.divider === null
  if (state.divider !== null) {
    place(divider, state.divider, origin)
    divider.dataset['orientation'] = state.orientation
  }
}

split.onState(draw)

/** Where the pointer is along the divider's axis, in this view's own coordinates. */
const along = (event: PointerEvent): number => (current?.orientation === 'column' ? event.clientY : event.clientX)

/** The pointer that pressed the divider, while it is held. */
let dragging: number | null = null

divider.addEventListener('pointerdown', (event) => {
  dragging = event.pointerId
  divider.setPointerCapture(event.pointerId)
  divider.classList.add('dragging')
})
// The drag follows its pointer anywhere in this view, not only through the divider's capture: main lays the panes out
// again under the pointer at every step, and a capture that drops then must neither freeze the drag nor keep it on.
window.addEventListener('pointermove', (event) => {
  if (event.pointerId === dragging && (event.buttons & 1) === 1) split.drag(along(event))
})
const release = (event: PointerEvent): void => {
  if (event.pointerId !== dragging) return
  dragging = null
  if (divider.hasPointerCapture(event.pointerId)) divider.releasePointerCapture(event.pointerId)
  divider.classList.remove('dragging')
}
window.addEventListener('pointerup', release)
window.addEventListener('pointercancel', release)
divider.addEventListener('dblclick', () => { split.reset() })
