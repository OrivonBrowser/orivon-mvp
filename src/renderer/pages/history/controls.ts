// The two choices above the list: how it is grouped and how it is sorted. Neither is kept between visits.
import type { HistoryOrder } from '../../../main/history/history-store.js'
import { h } from '../shared/dom.js'
import type { Grouping } from './layout.js'

const GROUPS: ReadonlyArray<readonly [Grouping, string]> = [['day', 'By day'], ['session', 'By session']]
const SORTS: ReadonlyArray<readonly [HistoryOrder, string]> = [['recent', 'Most recent'], ['visits', 'Most visited'], ['title', 'Name (A to Z)']]

export interface Controls {
  readonly element: HTMLElement
  /** Shows the current choices; grouping is hidden while the list is sorted. */
  sync: (grouping: Grouping, order: HistoryOrder) => void
}

export function createControls (onGroup: (grouping: Grouping) => void, onSort: (order: HistoryOrder) => void): Controls {
  const group = h('div', { className: 'segmented', role: 'group' })
  group.setAttribute('aria-label', 'Group')
  const buttons = GROUPS.map(([value, label]) => h('button', { type: 'button', textContent: label, onclick: () => { onGroup(value) } }))
  group.append(...buttons)
  const sort = h('select', { className: 'select sort' }, ...SORTS.map(([value, label]) => h('option', { value, textContent: label })))
  sort.id = 'sort'
  sort.addEventListener('change', () => { onSort(sort.value as HistoryOrder) })
  const hint = h('p', { className: 'hint', textContent: 'Groups pages you visited close together.' })
  const groupWrap = h('div', { className: 'control' }, h('span', { className: 'control-label', textContent: 'Group' }), group)
  const element = h('div', { className: 'view-controls' },
    groupWrap,
    h('div', { className: 'control' }, h('label', { className: 'control-label', htmlFor: 'sort', textContent: 'Sort' }), sort),
    hint)
  return {
    element,
    sync: (grouping, order) => {
      GROUPS.forEach(([value], index) => {
        const button = buttons[index] as HTMLButtonElement
        button.setAttribute('aria-pressed', String(value === grouping))
      })
      // Grouping only means something in the most recent order, so it is out of the way in the others.
      groupWrap.hidden = order !== 'recent'
      sort.value = order
      hint.classList.toggle('shown', grouping === 'session' && order === 'recent')
    }
  }
}
