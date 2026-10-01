// The card of tabs and windows closed a moment ago, above the list. Enter or a click brings one back where it was.
import { h } from '../shared/dom.js'
import { fileIcon, tabsIcon } from '../shared/icons.js'
import { relativeTime } from './relative-time.js'

export interface ClosedRow {
  readonly id: number
  readonly kind: 'tab' | 'window'
  readonly title: string
  readonly address: string
  readonly tabs: number
  readonly at: number
  readonly favicon: string | null
}

export function closedTitle (row: ClosedRow): string {
  if (row.kind === 'window') return `Window (${String(row.tabs)} ${row.tabs === 1 ? 'tab' : 'tabs'})`
  return row.title === '' ? row.address : row.title
}

function renderItem (row: ClosedRow, now: number): HTMLElement {
  const icon = row.favicon?.startsWith('data:image/') === true
    ? h('img', { src: row.favicon, alt: '', draggable: false })
    : row.kind === 'window' ? tabsIcon() : fileIcon()
  const item = h('li', { className: 'listbox-item closed-item', role: 'option', tabIndex: -1 },
    h('span', { className: 'item-icon' }, icon),
    h('span', { className: 'item-title', textContent: closedTitle(row) }),
    h('span', { className: 'item-sub', textContent: row.address }),
    h('span', { className: 'item-meta', textContent: relativeTime(row.at, now) }))
  item.dataset['id'] = String(row.id)
  item.setAttribute('aria-selected', 'false')
  return item
}

/** `null` when nothing was closed. `onReopen` is told the row's id. */
export function renderClosed (rows: readonly ClosedRow[], now: number, onReopen: (id: number) => void): HTMLElement | null {
  if (rows.length === 0) return null
  const items = rows.map((row) => renderItem(row, now))
  const list = h('ul', { className: 'listbox', role: 'listbox' }, ...items)
  list.setAttribute('aria-label', 'Recently closed')
  const rove = (to: number): void => {
    const target = items[Math.min(items.length - 1, Math.max(0, to))]
    for (const item of items) item.tabIndex = item === target ? 0 : -1
    target?.focus()
  }
  items.forEach((item, index) => {
    item.tabIndex = index === 0 ? 0 : -1
    item.addEventListener('click', () => { onReopen(Number(item.dataset['id'])) })
    item.addEventListener('keydown', (event) => {
      const at = items.indexOf(item)
      if (event.key === 'Enter' || event.key === ' ') onReopen(Number(item.dataset['id']))
      else if (event.key === 'ArrowDown') rove(at + 1)
      else if (event.key === 'ArrowUp') rove(at - 1)
      else if (event.key === 'Home') rove(0)
      else if (event.key === 'End') rove(items.length - 1)
      else return
      event.preventDefault()
    })
  })
  return h('section', { className: 'closed' }, h('h2', { className: 'group-label', textContent: 'Recently closed' }), list)
}
