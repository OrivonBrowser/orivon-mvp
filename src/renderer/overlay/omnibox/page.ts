// The address bar's dropdown. The field in the chrome keeps focus and every key; this page only draws the rows
// main sends and reports the one a mouse pressed. The choice is taken on the press, not the click: the field
// blurs to this view on the press, and the chrome closes the list on that blur.
import { faviconElement, globeIcon } from '../../icons.js'
import { h } from '../../pages/shared/dom.js'
import { searchGlassIcon, starIcon } from '../../pages/shared/icons.js'
import type { PageRow } from '../../../main/omnibox/omnibox-service.js'
import type { Overlay, OverlayPage } from '../kit.js'
import { segments } from '../tab-search/fuzzy.js'
import { asRowsMessage, dispositionFor } from './rows.js'
import type { RowsMessage } from './rows.js'
import './omnibox.css'

function highlighted (text: string, ranges: ReadonlyArray<readonly [number, number]>): Node[] {
  return segments(text, ranges).map((piece) => piece.hit ? h('mark', null, piece.text) : document.createTextNode(piece.text))
}

function iconFor (row: PageRow): HTMLElement {
  const box = h('span', { className: 'item-icon' })
  if (row.kind === 'verbatim') box.append(globeIcon())
  else if (row.kind === 'search') box.append(searchGlassIcon())
  else box.append(faviconElement(row.favicon))
  return box
}

function metaFor (row: PageRow): HTMLElement | null {
  if (row.kind === 'bookmark') {
    const star = h('span', { className: 'item-meta omni-star', title: 'Bookmarked' }, starIcon())
    star.setAttribute('role', 'img')
    star.setAttribute('aria-label', 'Bookmarked')
    return star
  }
  if (row.meta === '') return null
  return h('span', { className: row.kind === 'tab' ? 'item-meta' : 'item-meta omni-meta' }, row.kind === 'tab' ? h('span', { className: 'chip' }, row.meta) : row.meta)
}

export const omniboxPage: OverlayPage = {
  mount (content, overlay: Overlay) {
    let seq = 0
    const list = h('ul', { className: 'listbox', id: 'omnibox-list', role: 'listbox', ariaLabel: 'Suggestions' })
    content.append(list)

    function rowElement (row: PageRow, index: number, selected: boolean): HTMLElement {
      const sameAsTitle = row.address === row.title
      const parts: Array<Node | null> = [
        iconFor(row),
        h('span', { className: 'item-title' }, ...highlighted(row.title, row.match)),
        row.address === '' || sameAsTitle ? null : h('span', { className: 'omni-dash', ariaHidden: 'true' }, '—'),
        row.address === '' || sameAsTitle ? null : h('span', { className: 'item-sub' }, ...highlighted(row.address, row.addressMatch)),
        metaFor(row)
      ]
      const el = h('li', { className: 'listbox-item', id: `omnibox-option-${String(index)}`, role: 'option', title: row.address === '' ? row.title : `${row.title}\n${row.address}` },
        ...parts.filter((part): part is Node => part !== null))
      el.setAttribute('aria-selected', String(selected))
      if (row.address === '' || sameAsTitle) el.classList.add('no-sub')
      el.addEventListener('mousedown', (event) => {
        const disposition = dispositionFor(event)
        // No focus change and no middle-press autoscroll: the field stays where the person is typing.
        event.preventDefault()
        if (disposition === null) return
        void overlay.request({ type: 'pick', index, disposition, seq })
      })
      return el
    }

    function render (message: RowsMessage): void {
      seq = message.seq
      list.replaceChildren(...message.rows.map((row, index) => rowElement(row, index, index === message.selected)))
    }

    overlay.onEvent((event) => {
      if (typeof event !== 'object' || event === null || (event as { type?: unknown }).type !== 'rows') return
      const message = asRowsMessage(event)
      if (message !== null) render(message)
    })

    return {
      shown (payload) {
        const message = asRowsMessage(payload)
        if (message !== null) render(message)
      }
    }
  }
}
