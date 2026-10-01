// Dragging rows to reorder them or file them in a folder, with pointer events (HTML drag and drop would hand the
// rows to the operating system). A count badge follows the pointer; a line shows the gap a row would land in and a
// ring shows the folder it would land inside, in the list or the tree. Escape leaves everything where it was.
import { h } from '../shared/dom.js'
import { dropAt } from './drop-target.js'
import type { Drop, RowBox } from './drop-target.js'

export interface DragHost {
  /** The scrolling box the list is in: the drop line is placed inside it. */
  readonly pane: HTMLElement
  readonly tree: HTMLElement
  /** False while a search, an edit or a dialog has the page: nothing drags then. */
  enabled: () => boolean
  /** The rows that move when `id` is dragged: the chosen ones if it is among them, else it alone (and it becomes the choice). */
  grab: (id: string) => string[]
  /** The folders a drag of `ids` may not be dropped in: themselves and what is inside them. */
  blocked: (ids: readonly string[]) => ReadonlySet<string>
  folderIds: () => ReadonlySet<string>
  /** `parent` null: the folder the list shows. */
  drop: (ids: readonly string[], parent: string | null, index: number | undefined) => void
}

const THRESHOLD = 5
const EDGE = 32
const SCROLL_STEP = 14

export function installDrag (host: DragHost): void {
  let start: { x: number, y: number, id: string } | null = null
  let active: { ids: string[], blocked: ReadonlySet<string>, badge: HTMLElement, line: HTMLElement } | null = null
  let target: { into: string } | { index: number } | null = null

  const listBoxes = (): RowBox[] => [...host.pane.querySelectorAll<HTMLElement>('.bm-row[data-id]')].map((row) => {
    const box = row.getBoundingClientRect()
    return { id: row.dataset['id'] ?? '', top: box.top, bottom: box.bottom, folder: row.dataset['kind'] === 'folder' }
  })

  const clearMarks = (): void => {
    for (const el of document.querySelectorAll('.drop-into')) el.classList.remove('drop-into')
    active?.line.setAttribute('hidden', '')
  }

  const over = (x: number, y: number, state: NonNullable<typeof active>): void => {
    clearMarks()
    target = null
    const under = document.elementFromPoint(x, y)
    const treeItem = under?.closest<HTMLElement>('.tree-item') ?? null
    if (treeItem !== null && host.tree.contains(treeItem)) {
      const id = treeItem.dataset['id'] ?? ''
      if (host.folderIds().has(id) && !state.blocked.has(id)) { treeItem.classList.add('drop-into'); target = { into: id } }
      return
    }
    const pane = host.pane.getBoundingClientRect()
    if (x < pane.left || x > pane.right || y < pane.top || y > pane.bottom) return
    if (y < pane.top + EDGE) host.pane.scrollTop -= SCROLL_STEP
    else if (y > pane.bottom - EDGE) host.pane.scrollTop += SCROLL_STEP
    const drop: Drop | null = dropAt(y, listBoxes(), new Set(state.ids))
    if (drop === null) return
    if (drop.kind === 'into') {
      if (state.blocked.has(drop.id)) return
      host.pane.querySelector(`.bm-row[data-id="${CSS.escape(drop.id)}"]`)?.classList.add('drop-into')
      target = { into: drop.id }
      return
    }
    state.line.removeAttribute('hidden')
    state.line.style.top = `${String(drop.line - pane.top + host.pane.scrollTop - 1)}px`
    target = { index: drop.index }
  }

  const finish = (): void => {
    clearMarks()
    active?.badge.remove()
    active?.line.remove()
    document.body.classList.remove('dragging')
    for (const row of host.pane.querySelectorAll('.bm-row.dragging')) row.classList.remove('dragging')
    active = null
    target = null
    start = null
  }

  host.pane.addEventListener('pointerdown', (event) => {
    if (event.button !== 0 || !host.enabled()) return
    const row = (event.target as HTMLElement).closest<HTMLElement>('.bm-row[data-id]')
    if (row === null || (event.target as HTMLElement).closest('button, input, a') !== null) return
    start = { x: event.clientX, y: event.clientY, id: row.dataset['id'] ?? '' }
  })

  window.addEventListener('pointermove', (event) => {
    if (start === null) return
    if (active === null) {
      if (Math.hypot(event.clientX - start.x, event.clientY - start.y) < THRESHOLD || !host.enabled()) return
      const ids = host.grab(start.id)
      const badge = h('div', { className: 'drag-badge', textContent: String(ids.length) })
      const line = h('div', { className: 'drop-line', hidden: true })
      line.style.position = 'absolute'
      line.style.left = '8px'
      line.style.right = '8px'
      host.pane.append(line)
      document.body.append(badge)
      document.body.classList.add('dragging')
      for (const id of ids) host.pane.querySelector(`.bm-row[data-id="${CSS.escape(id)}"]`)?.classList.add('dragging')
      active = { ids, blocked: host.blocked(ids), badge, line }
    }
    active.badge.style.left = `${String(event.clientX + 14)}px`
    active.badge.style.top = `${String(event.clientY + 14)}px`
    over(event.clientX, event.clientY, active)
  })

  window.addEventListener('pointerup', () => {
    const dragged = active
    const landing = target
    finish()
    if (dragged === null) return
    // The release that ends a drag must not also click the row it ends on.
    const swallow = (event: Event): void => { event.stopPropagation() }
    window.addEventListener('click', swallow, { capture: true, once: true })
    setTimeout(() => { window.removeEventListener('click', swallow, true) }, 0)
    if (landing === null) return
    if ('into' in landing) host.drop(dragged.ids, landing.into, undefined)
    else host.drop(dragged.ids, null, landing.index)
  })

  const cancel = (): void => { finish() }
  window.addEventListener('pointercancel', cancel)
  window.addEventListener('blur', cancel)
  document.addEventListener('keydown', (event) => {
    if (event.key !== 'Escape' || active === null) return
    event.preventDefault()
    event.stopPropagation()
    finish()
  }, true)
}
