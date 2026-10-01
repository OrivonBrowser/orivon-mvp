// Dragging a group's chip moves the whole group: the chip and the group's tabs follow the pointer, and letting go
// asks main to put the group at the place the pointer is over, among the tabs outside it.
import { DRAG_THRESHOLD_PX, dropIndex, holdStrip } from '../tab-drag.js'
import type { ChromeContext } from './context.js'

/** The place among the tabs outside the group (shown ones) a pointer at `x` is over, given the centres of those tabs. */
export function groupDropIndex (centres: readonly number[], x: number): number {
  return dropIndex(centres, x)
}

export function makeChipDraggable (chip: HTMLElement, id: string, ctx: ChromeContext): void {
  let start: { x: number, pointerId: number } | null = null
  let moving = false
  let members: HTMLElement[] = []
  let others: HTMLElement[] = []
  let centres: number[] = []
  let chipLeft = 0

  const strip = (): HTMLElement | null => chip.closest<HTMLElement>('#tabrow')
  const reset = (): void => {
    for (const el of [chip, ...members]) {
      el.style.transform = ''
      el.classList.remove('dragging')
    }
    if (start !== null && chip.hasPointerCapture(start.pointerId)) chip.releasePointerCapture(start.pointerId)
    start = null
    moving = false
    holdStrip(false)
  }

  chip.addEventListener('pointerdown', (event) => {
    if (event.button !== 0) return
    start = { x: event.clientX, pointerId: event.pointerId }
    chip.setPointerCapture(event.pointerId)
  })

  chip.addEventListener('pointermove', (event) => {
    if (start === null) return
    if (!moving) {
      if (Math.abs(event.clientX - start.x) < DRAG_THRESHOLD_PX) return
      const row = strip()
      if (row === null) return
      const all = [...row.querySelectorAll<HTMLElement>('.tab')]
      members = all.filter((tab) => tab.dataset['group'] === id && !tab.hidden)
      others = all.filter((tab) => tab.dataset['group'] !== id && !tab.hidden)
      centres = others.map((tab) => { const box = tab.getBoundingClientRect(); return box.left + box.width / 2 })
      chipLeft = chip.getBoundingClientRect().left
      moving = true
      holdStrip(true)
      for (const el of [chip, ...members]) el.classList.add('dragging')
    }
    for (const el of [chip, ...members]) el.style.transform = `translateX(${String(event.clientX - start.x)}px)`
  })

  /** Every tab outside the group, hidden ones too: the places `moveTab` counts. */
  const outside = (): HTMLElement[] => [...(strip()?.querySelectorAll<HTMLElement>('.tab') ?? [])].filter((tab) => tab.dataset['group'] !== id)

  chip.addEventListener('pointerup', (event) => {
    if (start === null) return
    if (!moving) { reset(); return }
    // The group's own left edge decides, as a tab's does: it is what the person is carrying.
    const before = others[groupDropIndex(centres, chipLeft + (event.clientX - start.x))]
    const all = outside()
    const place = before === undefined ? all.length : all.indexOf(before)
    // The click that follows a drag must not also collapse the group.
    chip.addEventListener('click', (click) => { click.stopImmediatePropagation() }, { capture: true, once: true })
    reset()
    void ctx.shell.act('group.move', { id, index: place })
  })

  chip.addEventListener('pointercancel', () => {
    if (!moving) { reset(); return }
    const index = outside().filter((tab) => (tab.compareDocumentPosition(chip) & Node.DOCUMENT_POSITION_FOLLOWING) !== 0).length
    reset()
    // Nothing moved, but redraws were held back while the chip was in hand.
    void ctx.shell.act('group.move', { id, index })
  })
}
