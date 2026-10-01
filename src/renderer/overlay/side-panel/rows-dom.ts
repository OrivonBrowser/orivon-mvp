// One row of the panel's list as an element: a listbox option, a tree item, or a heading. Text only, always
// through `h()`; the match is marked with <mark> pieces cut by `pieces`.
import { faviconElement } from '../../icons.js'
import { h } from '../../pages/shared/dom.js'
import { fileIcon, folderIcon, folderOpenIcon } from '../../pages/shared/icons.js'
import { pieces } from './rows.js'
import type { ShownRow } from './rows.js'

export interface RowOptions {
  /** The query typed, for marking matches. */
  query: string
  /** A tree row (folders fold) rather than a listbox option. */
  tree: boolean
  /** This row waits for a second Delete. */
  armed: boolean
  domId: string
  /** Which view the row belongs to: a download has no site icon. */
  downloads: boolean
}

export const ARMED_TEXT = 'Press Delete again to remove'

function marked (text: string, query: string): Node[] {
  return pieces(text, query).map((piece) => piece.hit ? h('mark', null, piece.text) : document.createTextNode(piece.text))
}

function iconFor (row: ShownRow, downloads: boolean): HTMLElement {
  const box = h('span', { className: 'item-icon' })
  if (row.kind === 'folder') box.append(row.expanded === true ? folderOpenIcon() : folderIcon())
  else if (downloads) box.append(fileIcon())
  else box.append(faviconElement(row.favicon ?? null))
  return box
}

function treeItem (row: ShownRow, options: RowOptions): HTMLElement {
  const folder = row.kind === 'folder'
  const toggle = h('button', { type: 'button', className: 'tree-toggle' })
  toggle.tabIndex = -1
  if (folder) toggle.setAttribute('aria-label', row.expanded === true ? 'Collapse' : 'Expand')
  else toggle.setAttribute('aria-hidden', 'true')
  const el = h('li', { className: 'tree-item', id: options.domId, role: 'treeitem', title: row.sub === undefined ? row.title : `${row.title}\n${row.sub}` },
    toggle, iconFor(row, false), h('span', { className: 'tree-label' }, ...marked(row.title, options.query)),
    options.armed ? h('span', { className: 'item-meta sp-armed' }, ARMED_TEXT) : row.sub === undefined ? null : h('span', { className: 'item-sub' }, ...marked(row.sub, options.query))
  )
  el.style.setProperty('--level', String(row.level ?? 0))
  el.setAttribute('aria-level', String((row.level ?? 0) + 1))
  if (folder) el.setAttribute('aria-expanded', String(row.expanded === true))
  return el
}

function option (row: ShownRow, options: RowOptions): HTMLElement {
  const meta = options.armed ? ARMED_TEXT : row.meta
  const el = h('li', { className: 'listbox-item', id: options.domId, role: 'option', title: row.sub === undefined ? row.title : `${row.title}\n${row.sub}` },
    iconFor(row, options.downloads),
    h('span', { className: 'item-title' }, ...marked(row.title, options.query)),
    row.sub === undefined ? null : h('span', { className: 'item-sub' }, ...marked(row.sub, options.query)),
    meta === undefined ? null : h('span', { className: options.armed ? 'item-meta sp-armed' : 'item-meta' }, meta)
  )
  if (row.sub === undefined) el.classList.add('no-sub')
  if (row.progress !== undefined) {
    const bar = h('span', { className: 'progress-bar' })
    const track = h('div', { className: row.progress === null ? 'progress indeterminate sp-progress' : 'progress sp-progress', role: 'progressbar', ariaLabel: `Downloading ${row.title}` }, bar)
    if (row.progress !== null) {
      bar.style.setProperty('--value', String(row.progress))
      track.setAttribute('aria-valuenow', String(Math.round(row.progress * 100)))
    }
    el.append(track)
  }
  return el
}

export function rowElement (row: ShownRow, options: RowOptions): HTMLElement {
  if (row.kind === 'header') return h('li', { className: 'sp-group', role: 'presentation' }, row.title)
  const el = options.tree ? treeItem(row, options) : option(row, options)
  el.dataset['id'] = row.id
  el.setAttribute('aria-selected', 'false')
  return el
}
