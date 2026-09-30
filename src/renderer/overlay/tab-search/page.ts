// Tab search: a field over a list of open tabs and recently closed ones. Main sends the rows and keeps them
// current; ranking, highlighting and the keyboard model are here. The field keeps focus throughout and the
// list is driven with aria-activedescendant, so typing never stops for a click or an arrow.
import type { SearchClosedRow, SearchRow, SearchTabRow } from '../../../main/tab-search/tab-search-model.js'
import { faviconElement } from '../../icons.js'
import { h } from '../../pages/shared/dom.js'
import { closeIcon, pinIcon, refreshIcon, searchGlassIcon, speakerIcon, speakerOffIcon } from '../../pages/shared/icons.js'
import type { Overlay, OverlayPage } from '../kit.js'
import { segments } from './fuzzy.js'
import type { Range } from './fuzzy.js'
import { PAGE_STEP, agoText, countLine, flatten, groupsFor, keyOf, move, reconcile } from './list-model.js'
import type { Group, Item } from './list-model.js'
import './tab-search.css'

const isRecord = (value: unknown): value is Record<string, unknown> => typeof value === 'object' && value !== null
const MAX_QUERY_SHOWN = 40

/** The rows of a show or an update; anything that is not a row main builds is dropped. */
function asRows (payload: unknown): SearchRow[] {
  const list = isRecord(payload) ? payload['rows'] : undefined
  if (!Array.isArray(list)) return []
  return list.filter((row): row is SearchRow => isRecord(row) && (
    (row['kind'] === 'tab' && typeof row['id'] === 'string' && typeof row['title'] === 'string' && typeof row['host'] === 'string') ||
    (row['kind'] === 'closed' && typeof row['entryId'] === 'number' && typeof row['title'] === 'string' && typeof row['host'] === 'string' && typeof row['at'] === 'number')
  ))
}

function highlighted (text: string, ranges: readonly Range[]): Node[] {
  return segments(text, ranges).map((piece) => piece.hit ? h('mark', null, piece.text) : document.createTextNode(piece.text))
}

function iconFor (row: SearchRow): HTMLElement {
  const box = h('span', { className: 'item-icon' })
  if (row.kind === 'closed') box.append(refreshIcon())
  else if (row.isNewTab) box.append(h('span', { className: 'ts-mark' }))
  else box.append(faviconElement(row.favicon))
  return box
}

function marks (row: SearchTabRow): HTMLElement[] {
  const dim = (label: string, ...children: Node[]): HTMLElement => {
    const mark = h('span', { className: 'ts-state', title: label }, ...children)
    mark.setAttribute('role', 'img')
    mark.setAttribute('aria-label', label)
    return mark
  }
  return [
    row.pinned ? dim('Pinned', pinIcon()) : null,
    row.muted ? dim('Muted', speakerOffIcon()) : row.audible ? dim('Playing audio', speakerIcon()) : null,
    row.otherWindow === null ? null : h('span', { className: 'badge' }, `Window ${String(row.otherWindow)}`),
    row.current ? h('span', { className: 'badge' }, 'This tab') : null
  ].filter((mark): mark is HTMLElement => mark !== null)
}

export const tabSearchPage: OverlayPage = {
  mount (content, overlay: Overlay) {
    let rows: SearchRow[] = []
    let query = ''
    let selected: string | null = null
    /** Rows the person closed a moment ago: gone from the list now, and from main's rows once it has closed them. */
    let hidden = new Set<string>()
    let keys: string[] = []
    const elements = new Map<string, HTMLElement>()
    let items = new Map<string, Item>()

    const input = h('input', {
      className: 'text search ts-input', type: 'search', placeholder: 'Search tabs', ariaLabel: 'Search tabs', spellcheck: false, autocomplete: 'off'
    })
    input.setAttribute('role', 'combobox')
    input.setAttribute('aria-controls', 'tab-search-list')
    input.setAttribute('aria-expanded', 'true')
    input.setAttribute('aria-autocomplete', 'list')
    const count = h('span', { className: 'ts-count', role: 'status' })
    count.setAttribute('aria-live', 'polite')
    const list = h('ul', { className: 'listbox', id: 'tab-search-list', role: 'listbox', ariaLabel: 'Tabs' })
    content.append(h('div', { className: 'ts-head' }, input, count), h('div', { className: 'ts-body' }, list))

    function closeRow (key: string | null): void {
      const item = key === null ? undefined : items.get(key)
      if (item === undefined || item.row.kind !== 'tab') return
      const order = keys
      if (selected === item.key) {
        const at = order.indexOf(item.key)
        selected = order[at + 1] ?? order[at - 1] ?? null
      }
      hidden = new Set(hidden).add(item.key)
      void overlay.request({ type: 'close', id: item.row.id })
      render()
    }

    function activate (key: string | null): void {
      const item = key === null ? undefined : items.get(key)
      if (item === undefined) return
      void overlay.request(item.row.kind === 'tab' ? { type: 'activate', id: item.row.id } : { type: 'reopen', entryId: item.row.entryId })
    }

    function setSelected (key: string | null, scroll: boolean): void {
      selected = key
      for (const [other, el] of elements) {
        const on = other === key
        el.setAttribute('aria-selected', String(on))
        el.querySelector<HTMLElement>('.ts-close')?.setAttribute('tabindex', on ? '0' : '-1')
      }
      const el = key === null ? undefined : elements.get(key)
      if (el === undefined) input.removeAttribute('aria-activedescendant')
      else {
        input.setAttribute('aria-activedescendant', el.id)
        if (scroll) el.scrollIntoView({ block: 'nearest' })
      }
    }

    function rowElement (item: Item, index: number): HTMLElement {
      const { row } = item
      const meta = h('span', { className: 'item-meta' })
      if (row.kind === 'tab') {
        meta.append(...marks(row))
        const close = h('button', { type: 'button', className: 'btn icon ts-close', ariaLabel: `Close ${item.title}`, title: 'Close tab (Shift+Delete)' }, closeIcon())
        close.tabIndex = -1
        close.addEventListener('click', (event) => { event.stopPropagation(); closeRow(item.key); input.focus() })
        meta.append(close)
      } else {
        meta.append(h('span', { className: 'ts-ago' }, agoText((row as SearchClosedRow).at, Date.now())))
      }
      const el = h('li', { className: 'listbox-item', id: `tab-search-option-${String(index)}`, role: 'option', title: row.host === '' ? item.title : `${item.title}\n${row.host}` },
        iconFor(row),
        h('span', { className: 'item-title' }, ...highlighted(item.title, item.titleRanges)),
        row.host === '' ? null : h('span', { className: 'item-sub' }, ...highlighted(row.host, item.hostRanges)),
        meta
      )
      if (row.host === '') el.classList.add('no-sub')
      el.dataset['key'] = item.key
      el.addEventListener('click', () => { activate(item.key) })
      // Focus stays in the field whatever is clicked; a middle press would start autoscroll before the release that closes.
      el.addEventListener('mousedown', (event) => { event.preventDefault() })
      el.addEventListener('auxclick', (event) => {
        if (event.button !== 1) return
        event.preventDefault()
        closeRow(item.key)
      })
      return el
    }

    function groupElements (groups: readonly Group[]): HTMLElement[] {
      let index = 0
      return groups.flatMap((group) => [
        h('li', { className: 'ts-group', role: 'presentation' }, group.label),
        ...group.items.map((item) => rowElement(item, index++))
      ])
    }

    function render (): void {
      const groups = groupsFor(rows, query, hidden)
      const before = keys
      const inList = list.contains(document.activeElement)
      const flat = flatten(groups)
      items = new Map(flat.map((item) => [item.key, item]))
      keys = flat.map((item) => item.key)
      const at = reconcile(before, selected, keys)
      elements.clear()
      const children = groupElements(groups)
      if (keys.length === 0) {
        const shown = query.length > MAX_QUERY_SHOWN ? `${query.slice(0, MAX_QUERY_SHOWN)}…` : query
        const empty = h('li', { className: 'empty-state compact', role: 'presentation' },
          searchGlassIcon(), h('span', null, query.trim() === '' ? 'No tabs are open.' : `No tabs match "${shown}".`))
        list.replaceChildren(empty)
      } else {
        list.replaceChildren(...children)
        for (const el of list.querySelectorAll<HTMLElement>('[data-key]')) elements.set(el.dataset['key'] ?? '', el)
      }
      const visible = rows.filter((row) => !hidden.has(keyOf(row)))
      count.textContent = query.trim() === '' ? countLine(visible) : countLine(visible, groups.find((group) => group.id === 'open')?.items.length ?? 0)
      setSelected(at, false)
      // A row rebuilt under the focus (an update arrived while Tab had reached a close button) gives it back to the field.
      if (inList) input.focus()
    }

    function step (delta: number, wrap: boolean): void {
      setSelected(move(keys, selected, delta, wrap), true)
    }

    input.addEventListener('input', () => {
      query = input.value
      selected = null
      render()
      list.closest('#scroll')?.scrollTo({ top: 0 })
    })

    content.addEventListener('keydown', (event) => {
      const onField = event.target === input
      const plain = !event.ctrlKey && !event.metaKey && !event.altKey
      switch (event.key) {
        case 'ArrowDown': step(1, true); break
        case 'ArrowUp': step(-1, true); break
        case 'PageDown': step(PAGE_STEP, false); break
        case 'PageUp': step(-PAGE_STEP, false); break
        case 'Home': if (!onField || query !== '') return; setSelected(keys[0] ?? null, true); break
        case 'End': if (!onField || query !== '') return; setSelected(keys.at(-1) ?? null, true); break
        case 'Enter': if (!onField) return; activate(selected); break
        case 'Delete': if (!event.shiftKey || !plain) return; closeRow(selected); break
        case 'Escape':
          // The first press empties the field; the kit closes the overlay on one the page left alone.
          if (query === '') return
          input.value = ''
          query = ''
          selected = null
          render()
          break
        default: return
      }
      event.preventDefault()
      if (!onField) input.focus()
    })

    overlay.onEvent((event) => {
      if (!isRecord(event) || event['type'] !== 'rows') return
      rows = asRows(event)
      const still = new Set(rows.map(keyOf))
      hidden = new Set([...hidden].filter((key) => still.has(key)))
      render()
    })

    return {
      shown (payload) {
        rows = asRows(payload)
        hidden = new Set()
        query = ''
        input.value = ''
        selected = null
        render()
        input.focus()
      }
    }
  }
}
