// The rows of the list and the headings between them. Each row is a listbox option; one is in the tab order at a
// time, and its buttons with it, so the list is a single stop and Tab from a row reaches that row's own buttons.
import type { HistoryEntry } from '../../../main/history/history-store.js'
import { h } from '../shared/dom.js'
import { chevronDownIcon, moreIcon, trashIcon } from '../shared/icons.js'
import { timeLabel } from './days.js'
import type { Section } from './layout.js'
import { siteMark } from './site-mark.js'

export type Disposition = 'tab' | 'newTab' | 'background' | 'window'

export interface RowActions {
  open: (entry: HistoryEntry, disposition: Disposition) => void
  /** `extend`: the shift key was held, so the rows between the last choice and this one are chosen. */
  toggle: (entry: HistoryEntry, extend: boolean) => void
  menu: (entry: HistoryEntry, place: { x: number, y: number, alignRight: boolean }, opener: HTMLElement | null) => void
  remove: (entry: HistoryEntry) => void
  collapse: (key: number) => void
}

export interface RowView {
  readonly selected: ReadonlySet<number>
  readonly showVisits: boolean
}

const titleOf = (entry: HistoryEntry): string => entry.title === '' ? entry.url : entry.title

export function visitsLabel (count: number): string {
  return `${count.toLocaleString()} ${count === 1 ? 'visit' : 'visits'}`
}

export function renderRow (entry: HistoryEntry, view: RowView, actions: RowActions): HTMLElement {
  const title = titleOf(entry)
  const chosen = view.selected.has(entry.id)
  const check = h('input', { type: 'checkbox', checked: chosen, tabIndex: -1 })
  check.setAttribute('aria-label', `Select ${title}`)
  check.addEventListener('click', (event) => { actions.toggle(entry, event.shiftKey) })

  const target = h('a', { className: 'target', href: entry.url, tabIndex: -1, rel: 'noopener' },
    h('span', { className: 'title', textContent: title }),
    h('span', { className: 'url', textContent: entry.url }))
  target.addEventListener('click', (event) => {
    event.preventDefault()
    actions.open(entry, event.shiftKey ? 'window' : event.ctrlKey || event.metaKey ? 'background' : 'tab')
  })
  target.addEventListener('mousedown', (event) => { if (event.button === 1) event.preventDefault() })
  target.addEventListener('auxclick', (event) => {
    if (event.button !== 1) return
    event.preventDefault()
    actions.open(entry, 'background')
  })

  const more = h('button', { className: 'btn icon more', type: 'button', tabIndex: -1 }, moreIcon())
  more.setAttribute('aria-label', `More actions for ${title}`)
  more.setAttribute('aria-haspopup', 'menu')
  more.addEventListener('click', () => {
    const box = more.getBoundingClientRect()
    actions.menu(entry, { x: box.right, y: box.bottom + 4, alignRight: true }, more)
  })
  const remove = h('button', { className: 'btn icon remove', type: 'button', tabIndex: -1, title: 'Remove this page from history' }, trashIcon())
  remove.setAttribute('aria-label', `Remove ${title} from history`)
  remove.addEventListener('click', () => { actions.remove(entry) })

  const row = h('div', { className: chosen ? 'entry selected' : 'entry', role: 'option', tabIndex: -1 },
    h('label', { className: 'check row-check' }, check),
    siteMark(entry.url, entry.favicon),
    target,
    h('span', { className: 'time', textContent: view.showVisits ? visitsLabel(entry.visitCount) : timeLabel(entry.lastVisit) }),
    more,
    remove)
  row.dataset['id'] = String(entry.id)
  row.setAttribute('aria-selected', String(chosen))
  row.addEventListener('contextmenu', (event) => {
    event.preventDefault()
    actions.menu(entry, { x: event.clientX, y: event.clientY, alignRight: false }, null)
  })
  return row
}

function renderHeading (key: number, label: string, pages: number, collapsed: boolean, actions: RowActions): HTMLElement {
  const head = h('button', { className: collapsed ? 'session-head collapsed' : 'session-head', type: 'button' },
    chevronDownIcon(),
    h('span', { className: 'session-label', textContent: label }),
    h('span', { className: 'session-count', textContent: `${pages.toLocaleString()} ${pages === 1 ? 'page' : 'pages'}` }))
  head.setAttribute('aria-expanded', String(!collapsed))
  head.dataset['key'] = String(key)
  head.addEventListener('click', () => { actions.collapse(key) })
  return head
}

function renderRun (entries: readonly HistoryEntry[], view: RowView, actions: RowActions): HTMLElement {
  const run = h('div', { className: 'entries', role: 'listbox' }, ...entries.map((entry) => renderRow(entry, view, actions)))
  run.setAttribute('aria-multiselectable', 'true')
  run.setAttribute('aria-label', 'Pages')
  return run
}

export function renderSections (sections: readonly Section[], view: RowView, actions: RowActions): HTMLElement[] {
  return sections.map((section) => h('section', { className: 'day' },
    section.label === '' ? null : h('h2', { textContent: section.label }),
    ...section.blocks.map((block) => {
      if (block.heading === undefined) return renderRun(block.entries, view, actions)
      const { key, label, pages } = block.heading
      return h('div', { className: 'session' }, renderHeading(key, label, pages, block.collapsed, actions), block.collapsed ? null : renderRun(block.entries, view, actions))
    })))
}

/** Puts exactly one row, and its buttons, in the tab order: `focusId`'s, else the first. */
export function applyRoving (root: ParentNode, focusId: number | null): void {
  const rows = [...root.querySelectorAll<HTMLElement>('.entry')]
  const active = rows.find((row) => Number(row.dataset['id']) === focusId) ?? rows[0]
  for (const row of rows) {
    const on = row === active
    row.tabIndex = on ? 0 : -1
    for (const button of row.querySelectorAll<HTMLElement>('button')) button.tabIndex = on ? 0 : -1
  }
}

export function rowElement (root: ParentNode, id: number | null): HTMLElement | null {
  return id === null ? null : root.querySelector<HTMLElement>(`.entry[data-id="${String(id)}"]`)
}
