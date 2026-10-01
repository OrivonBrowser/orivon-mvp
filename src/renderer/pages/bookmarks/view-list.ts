// The list at the right: the folder's rows (or a search's results), the path to the folder, and what stands in for
// rows when there are none. Each row is a listbox option; one is in the tab order at a time, and its button with it.
import { h } from '../shared/dom.js'
import { bookmarkIcon, folderIcon, moreIcon, webIcon } from '../shared/icons.js'
import { addressLabel, splitMatches } from './row-text.js'
import type { Crumb, Row } from './state.js'

export interface RowActions {
  /** A click on the row; the keys held say how the choice changes. */
  choose: (row: Row, event: MouseEvent) => void
  open: (row: Row, how: 'tab' | 'background') => void
  enter: (row: Row) => void
  menu: (row: Row, place: { x: number, y: number, alignRight: boolean }, opener: HTMLElement | null) => void
}

export interface ListView {
  readonly selected: ReadonlySet<string>
  readonly query: string
  readonly searching: boolean
  readonly focusId: string | null
  readonly shown: number
}

const itemsLabel = (count: number): string => `${count.toLocaleString()} ${count === 1 ? 'item' : 'items'}`

function marked (text: string, needle: string): Array<Node | string> {
  return splitMatches(text, needle).map((piece) => piece.match ? h('mark', { textContent: piece.text }) : piece.text)
}

/** A page's own icon, or the globe when it has none or the image does not load. */
export function rowIcon (row: Pick<Row, 'kind' | 'icon'>): HTMLElement {
  const holder = h('span', { className: 'item-icon' })
  if (row.kind === 'folder') {
    holder.append(folderIcon())
  } else if (row.icon === null) {
    holder.append(webIcon())
  } else {
    const img = h('img', { alt: '', decoding: 'async', referrerPolicy: 'no-referrer' })
    img.addEventListener('error', () => { img.replaceWith(webIcon()) }, { once: true })
    img.src = row.icon
    holder.append(img)
  }
  return holder
}

/** What the row is called when it has no title of its own. */
export const titleOf = (row: Pick<Row, 'title' | 'url'>): string => row.title === '' ? row.url ?? '' : row.title

export function renderRow (row: Row, view: ListView, actions: RowActions): HTMLElement {
  const title = titleOf(row)
  const chosen = view.selected.has(row.id)
  const sub = row.kind === 'folder' ? itemsLabel(row.items ?? 0) : addressLabel(row.url ?? '')
  const more = h('button', { className: 'btn icon more', type: 'button', tabIndex: -1 }, moreIcon())
  more.setAttribute('aria-label', `More actions for ${title}`)
  more.setAttribute('aria-haspopup', 'menu')
  more.addEventListener('click', (event) => {
    event.stopPropagation()
    const box = more.getBoundingClientRect()
    actions.menu(row, { x: box.right, y: box.bottom + 4, alignRight: true }, more)
  })
  const text = h('span', { className: 'bm-text' },
    h('span', { className: 'bm-line' },
      h('span', { className: 'bm-title', title }, ...marked(title, view.query)),
      h('span', { className: row.kind === 'folder' ? 'bm-sub count' : 'bm-sub', title: row.url ?? '' }, ...(row.kind === 'folder' ? [sub] : marked(sub, view.query)))),
    view.searching && row.path !== undefined ? h('span', { className: 'bm-path', textContent: `in ${row.path.join(' / ')}` }) : null)
  const el = h('div', { className: chosen ? 'bm-row selected' : 'bm-row', role: 'option', tabIndex: row.id === view.focusId ? 0 : -1 }, rowIcon(row), text, more)
  el.dataset['id'] = row.id
  el.dataset['kind'] = row.kind
  el.setAttribute('aria-selected', String(chosen))
  el.addEventListener('click', (event) => { actions.choose(row, event) })
  el.addEventListener('dblclick', () => { actions.enter(row) })
  el.addEventListener('mousedown', (event) => { if (event.button === 1) event.preventDefault() })
  el.addEventListener('auxclick', (event) => {
    if (event.button !== 1 || row.kind !== 'url') return
    event.preventDefault()
    actions.open(row, 'background')
  })
  el.addEventListener('contextmenu', (event) => {
    event.preventDefault()
    actions.menu(row, { x: event.clientX, y: event.clientY, alignRight: false }, null)
  })
  return el
}

/** The rows up to `view.shown`, and a button for the rest of a long folder. */
export function renderList (rows: readonly Row[], view: ListView, actions: RowActions, showMore: () => void): HTMLElement {
  const list = h('div', { className: 'bm-list', role: 'listbox' }, ...rows.slice(0, view.shown).map((row) => renderRow(row, view, actions)))
  list.setAttribute('aria-multiselectable', 'true')
  list.setAttribute('aria-label', view.searching ? 'Search results' : 'Bookmarks')
  if (rows.length > view.shown) {
    list.append(h('button', { className: 'btn bm-more', type: 'button', textContent: `Show more (${(rows.length - view.shown).toLocaleString()} left)`, onclick: showMore }))
  }
  return list
}

export function renderSkeleton (): HTMLElement {
  const rows = Array.from({ length: 7 }, () => h('div', { className: 'bm-row bm-skeleton' },
    h('span', { className: 'skeleton icon-box' }), h('span', { className: 'skeleton line' })))
  const list = h('div', { className: 'bm-list' }, ...rows)
  list.setAttribute('aria-busy', 'true')
  list.setAttribute('aria-label', 'Loading bookmarks')
  return list
}

export interface EmptyView {
  readonly query: string
  /** Nothing is bookmarked anywhere, not only in this folder. */
  readonly storeEmpty: boolean
  readonly importAvailable: boolean
  readonly importBookmarks: () => void
}

export function renderEmpty (view: EmptyView): HTMLElement {
  if (view.query !== '') return h('div', { className: 'empty-state' }, bookmarkIcon(), h('p', { textContent: `No bookmarks match "${view.query}".` }))
  const lines: Array<Node | string> = [h('p', { textContent: 'This folder is empty.' })]
  if (view.storeEmpty) {
    lines.push(h('p', { className: 'hint', textContent: 'Bookmark a page with the bookmark button next to the address bar (Ctrl+D), or import bookmarks from another browser.' }))
    if (view.importAvailable) lines.push(h('button', { className: 'btn', type: 'button', textContent: 'Import bookmarks…', onclick: view.importBookmarks }))
  }
  return h('div', { className: 'empty-state' }, bookmarkIcon(), ...lines)
}

/** Where the list is: each part but the last takes you there. While a search has the list it says so instead. */
export function renderCrumbs (crumbs: readonly Crumb[], searching: boolean, count: number, go: (id: string) => void): HTMLElement {
  const nav = h('nav', { className: 'crumbs' })
  nav.setAttribute('aria-label', 'Folder path')
  if (searching) {
    nav.append(h('span', { className: 'crumb-here', textContent: 'Search results' }), h('span', { className: 'crumb-count', textContent: `${count.toLocaleString()}${count === 200 ? '+' : ''} ${count === 1 ? 'result' : 'results'}` }))
    return nav
  }
  const parts: Array<Node | string> = []
  crumbs.forEach((crumb, index) => {
    if (index > 0) parts.push(h('span', { className: 'crumb-sep', textContent: '/' }))
    if (index === crumbs.length - 1) {
      const here = h('span', { className: 'crumb-here', textContent: crumb.title })
      here.setAttribute('aria-current', 'page')
      parts.push(here)
    } else {
      parts.push(h('button', { className: 'crumb link-btn', type: 'button', textContent: crumb.title, onclick: () => { go(crumb.id) } }))
    }
  })
  nav.append(h('ol', null, ...parts.map((part) => h('li', null, part))), h('span', { className: 'crumb-count', textContent: itemsLabel(count) }))
  return nav
}

export function rowElement (root: ParentNode, id: string | null): HTMLElement | null {
  return id === null ? null : root.querySelector<HTMLElement>(`.bm-row[data-id="${CSS.escape(id)}"]`)
}

/** Puts exactly one row, and its button, in the tab order: `focusId`'s, else the first. */
export function applyRoving (root: ParentNode, focusId: string | null): void {
  const rows = [...root.querySelectorAll<HTMLElement>('.bm-row[data-id]')]
  const active = rows.find((row) => row.dataset['id'] === focusId) ?? rows[0]
  for (const row of rows) {
    const on = row === active
    row.tabIndex = on ? 0 : -1
    for (const button of row.querySelectorAll<HTMLElement>('button')) button.tabIndex = on ? 0 : -1
  }
}

/** Shows which rows are chosen without drawing them again, so a double click still lands on the same element. */
export function applySelection (root: ParentNode, selected: ReadonlySet<string>): void {
  for (const row of root.querySelectorAll<HTMLElement>('.bm-row[data-id]')) {
    const on = selected.has(row.dataset['id'] ?? '')
    row.classList.toggle('selected', on)
    row.setAttribute('aria-selected', String(on))
  }
}
