// The bar over the list while any row is chosen: how many, open them, delete them (two clicks), or let go.
import { h } from '../shared/dom.js'

export interface BarActions {
  openAll: () => void
  remove: () => void
  cancel: () => void
}

/** Most pages opened at once. */
export const OPEN_ALL_LIMIT = 20

export function renderSelectionBar (count: number, armed: boolean, actions: BarActions): HTMLElement {
  const open = h('button', { className: 'btn', type: 'button', textContent: 'Open in new tabs', onclick: actions.openAll })
  if (count > OPEN_ALL_LIMIT) open.title = `Opens the first ${String(OPEN_ALL_LIMIT)}.`
  const remove = h('button', { className: armed ? 'btn danger armed' : 'btn danger', type: 'button', textContent: armed ? `Click again to delete ${String(count)}` : 'Delete', onclick: actions.remove })
  remove.dataset['action'] = 'delete'
  const bar = h('div', { className: 'selection-bar', role: 'toolbar' },
    h('span', { className: 'selection-count', textContent: `${String(count)} selected` }),
    h('div', { className: 'btn-row' }, open, remove, h('button', { className: 'link-btn', type: 'button', textContent: 'Cancel', onclick: actions.cancel })))
  bar.setAttribute('aria-label', 'Selected pages')
  bar.querySelector('.selection-count')?.setAttribute('aria-live', 'polite')
  return bar
}
