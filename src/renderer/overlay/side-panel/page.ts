// The side panel: a header with a view picker and a close button, a search field, and one list of rows that
// main builds for the chosen view. Main keeps the stores; this page draws rows, takes the keys and sends back the
// id of a row. A view Orivon does not draw (an extension's) is a native view laid over the body, header kept.
import { h } from '../../pages/shared/dom.js'
import { closeIcon, searchGlassIcon } from '../../pages/shared/icons.js'
import type { Overlay, OverlayPage } from '../kit.js'
import { createEdge } from './edge.js'
import { createPicker } from './picker.js'
import { rowElement } from './rows-dom.js'
import { emptyText, howOpens, moveSelection, reconcile, selectableIds, treeKey, withDays } from './rows.js'
import type { PanelRow, ShownRow } from './rows.js'
import { asGuest, asGuests, asLimits, asRows, asShown } from './shown.js'
import type { GuestMeta, Shown, ViewMeta } from './shown.js'
import { viewIcon } from './view-icons.js'
import './side-panel.css'

const SEARCH_DELAY_MS = 200
const ARM_MS = 4000
const isRecord = (value: unknown): value is Record<string, unknown> => typeof value === 'object' && value !== null

export const sidePanelPage: OverlayPage = {
  mount (content, overlay: Overlay) {
    let views: ViewMeta[] = []
    let guests: GuestMeta[] = []
    let view = ''
    let guest: GuestMeta | null = null
    let defaultOpen: string[] = []
    let open = new Set<string>()
    let firstShow = true
    let raw: PanelRow[] = []
    let shown: ShownRow[] = []
    let query = ''
    let selected: string | null = null
    let armed: string | null = null
    let armTimer: ReturnType<typeof setTimeout> | undefined
    let searchTimer: ReturnType<typeof setTimeout> | undefined
    let fetchSeq = 0
    let loading = false

    const root = h('div', { className: 'sp' })
    const send = (command: unknown): void => { void overlay.request(command) }
    const edge = createEdge((width) => { send({ type: 'resize', width }) }, root)
    const picker = createPicker((id) => { choose(id) })
    const close = h('button', { type: 'button', className: 'btn icon sp-close', ariaLabel: 'Close side panel', title: 'Close side panel' }, closeIcon())
    const input = h('input', { className: 'text search sp-input', type: 'search', spellcheck: false, autocomplete: 'off' })
    const list = h('ul', { className: 'sp-list' })
    list.tabIndex = 0
    const foot = h('div', { className: 'sp-foot' })
    const body = h('div', { className: 'sp-body' }, list, foot)
    const search = h('div', { className: 'sp-search' }, input)
    root.append(edge.el, h('div', { className: 'sp-main' },
      h('header', { className: 'sp-head' }, picker.button, close), picker.list, search, body))
    content.append(root)

    const current = (): ViewMeta | undefined => views.find((entry) => entry.id === view)
    const inGuest = (): boolean => current() === undefined && view !== ''
    const idsNow = (): string[] => selectableIds(shown)
    const rowById = (id: string | null): ShownRow | undefined => id === null ? undefined : shown.find((row) => row.id === id)
    const isTree = (): boolean => current()?.icon === 'bookmarks' && query.trim() === ''

    function disarm (): void {
      if (armed === null) return
      armed = null
      clearTimeout(armTimer)
      draw()
    }

    function applyRows (rows: PanelRow[]): void {
      const before = idsNow()
      raw = rows
      shown = withDays(rows, Date.now())
      selected = reconcile(before, selected, idsNow())
      loading = false
      draw()
    }

    function fetchRows (): void {
      const asked = view
      const seq = ++fetchSeq
      void overlay.request<unknown>({ type: 'rows', view: asked, query, open: [...open] }).then((reply) => {
        if (seq !== fetchSeq || asked !== view || !isRecord(reply) || reply['view'] !== asked) return
        const keep = body.scrollTop
        applyRows(asRows(reply['rows']))
        body.scrollTop = keep
      }).catch(() => {})
    }

    function setSelected (id: string | null, scroll: boolean): void {
      selected = id
      let activeId: string | null = null
      for (const el of list.querySelectorAll<HTMLElement>('[data-id]')) {
        const on = el.dataset['id'] === id
        el.setAttribute('aria-selected', String(on))
        if (on) {
          activeId = el.id
          if (scroll) el.scrollIntoView({ block: 'nearest' })
        }
      }
      if (activeId === null) list.removeAttribute('aria-activedescendant')
      else list.setAttribute('aria-activedescendant', activeId)
    }

    function drawFoot (meta: ViewMeta | undefined): void {
      if (meta === undefined || meta.page === null || shown.length === 0) { foot.replaceChildren(); return }
      const link = h('button', { type: 'button', className: 'link-btn' }, meta.page)
      link.addEventListener('click', () => { send({ type: 'page', view }) })
      foot.replaceChildren(link)
    }

    function draw (): void {
      const meta = current()
      picker.update(views, guests, view, guest)
      const guestShown = inGuest()
      search.hidden = guestShown
      body.hidden = guestShown
      if (guestShown) return
      input.placeholder = meta?.searchLabel ?? 'Search'
      input.setAttribute('aria-label', meta?.searchLabel ?? 'Search')
      list.setAttribute('role', isTree() ? 'tree' : 'listbox')
      list.setAttribute('aria-label', meta?.title ?? 'Panel')
      list.className = isTree() ? 'tree sp-list sp-tree' : 'listbox sp-list'
      if (loading) {
        list.replaceChildren(...[0, 1, 2, 3].map(() => h('li', { className: 'sp-skeleton', role: 'presentation' }, h('span', { className: 'skeleton' }))))
        drawFoot(undefined)
        return
      }
      if (shown.length === 0) {
        const text = emptyText(query, meta?.things ?? 'items', meta?.empty ?? '')
        list.replaceChildren(h('li', { className: 'empty-state compact', role: 'presentation' }, meta === undefined ? searchGlassIcon() : viewIcon(meta.icon), h('span', null, text)))
        drawFoot(undefined)
        return
      }
      const tree = isTree()
      let count = 0
      list.replaceChildren(...shown.map((row) => rowElement(row, {
        query, tree, armed: armed === row.id, domId: `sp-row-${String(count++)}`, downloads: meta?.icon === 'downloads'
      })))
      setSelected(selected, false)
      drawFoot(meta)
    }

    /** Shows `next` as the panel's view: its own search and selection, rows asked for. */
    function switchTo (next: string, nextGuest: GuestMeta | null): void {
      guest = nextGuest
      if (next === view) { draw(); return }
      view = next
      query = ''
      input.value = ''
      selected = null
      armed = null
      raw = []
      shown = []
      loading = current() !== undefined
      draw()
      if (current() !== undefined) fetchRows()
    }

    function choose (id: string): void {
      const meta = views.find((entry) => entry.id === id)
      switchTo(id, guests.find((entry) => entry.id === id) ?? null)
      send({ type: 'view', view: id })
      if (meta !== undefined) input.focus()
    }

    function toggleFolder (id: string, on: boolean): void {
      if (on) open.add(id)
      else open.delete(id)
      fetchRows()
    }

    function activate (id: string, how: 'current' | 'background' | 'window'): void {
      const row = rowById(id)
      if (row === undefined) return
      if (row.kind === 'folder' && query.trim() === '') { toggleFolder(id, row.expanded !== true); return }
      send({ type: 'open', view, id, how })
    }

    function removeSelected (): void {
      const row = rowById(selected)
      if (row === undefined || row.kind !== 'item' || current()?.removable !== true || selected === null) return
      if (armed !== row.id) {
        armed = row.id
        clearTimeout(armTimer)
        armTimer = setTimeout(disarm, ARM_MS)
        draw()
        return
      }
      const ids = idsNow()
      const next = ids[ids.indexOf(row.id) + 1] ?? ids[ids.indexOf(row.id) - 1] ?? null
      armed = null
      clearTimeout(armTimer)
      send({ type: 'remove', view, id: row.id })
      applyRows(raw.filter((entry) => entry.id !== row.id))
      setSelected(next, true)
    }

    function typed (): void {
      clearTimeout(searchTimer)
      searchTimer = setTimeout(() => {
        query = input.value
        selected = null
        armed = null
        fetchRows()
        body.scrollTop = 0
      }, SEARCH_DELAY_MS)
    }

    function rowKey (event: KeyboardEvent): void {
      const plain = !event.altKey && !event.metaKey
      const moves: Record<string, 'up' | 'down' | 'first' | 'last'> = { ArrowDown: 'down', ArrowUp: 'up', Home: 'first', End: 'last' }
      const how = moves[event.key]
      if (how !== undefined && plain) {
        event.preventDefault()
        disarm()
        setSelected(moveSelection(idsNow(), selected, how), true)
      } else if ((event.key === 'ArrowLeft' || event.key === 'ArrowRight') && isTree()) {
        const result = treeKey(shown, selected, event.key)
        if (result === null) return
        event.preventDefault()
        if (result.action === 'select') setSelected(result.id, true)
        else toggleFolder(result.id, result.action === 'expand')
      } else if (event.key === 'Enter' && selected !== null) {
        event.preventDefault()
        activate(selected, event.ctrlKey || event.metaKey ? 'background' : event.shiftKey ? 'window' : 'current')
      } else if (event.key === 'Delete' && plain) {
        event.preventDefault()
        removeSelected()
      }
    }

    list.addEventListener('keydown', rowKey)
    list.addEventListener('blur', disarm)
    list.addEventListener('mousedown', (event) => { if (event.button === 1) event.preventDefault() })
    const rowOf = (event: Event): HTMLElement | null => event.target instanceof Element ? event.target.closest<HTMLElement>('[data-id]') : null
    list.addEventListener('click', (event) => {
      const el = rowOf(event)
      const id = el?.dataset['id']
      if (el === null || id === undefined) return
      disarm()
      setSelected(id, false)
      if (event.target instanceof Element && event.target.closest('.tree-toggle') !== null) {
        const row = rowById(id)
        if (row !== undefined) toggleFolder(id, row.expanded !== true)
        return
      }
      activate(id, howOpens(event))
    })
    list.addEventListener('auxclick', (event) => {
      const id = rowOf(event)?.dataset['id']
      if (id === undefined || event.button !== 1) return
      event.preventDefault()
      activate(id, 'background')
    })
    input.addEventListener('input', typed)
    input.addEventListener('keydown', (event) => {
      if (event.key !== 'ArrowDown' && event.key !== 'ArrowUp') return
      event.preventDefault()
      list.focus()
      setSelected(selected ?? moveSelection(idsNow(), null, event.key === 'ArrowDown' ? 'first' : 'last'), true)
    })
    close.addEventListener('click', () => { send({ type: 'close' }) })

    // Escape never closes the panel: it clears what was typed, and once nothing is left it hands the keys to the page.
    content.addEventListener('keydown', (event) => {
      if (event.key !== 'Escape' || event.defaultPrevented) return
      event.preventDefault()
      if (picker.isOpen()) picker.close(true)
      else if (armed !== null) disarm()
      else if (query !== '' || input.value !== '') {
        clearTimeout(searchTimer)
        input.value = ''
        query = ''
        selected = null
        fetchRows()
        input.focus()
      } else send({ type: 'focus-page' })
    })

    overlay.onEvent((event) => {
      if (!isRecord(event)) return
      switch (event['type']) {
        case 'view': if (typeof event['view'] === 'string') switchTo(event['view'], asGuest(event['guest']) ?? guests.find((entry) => entry.id === event['view']) ?? null); break
        case 'changed': if (event['view'] === view && current() !== undefined) fetchRows(); break
        case 'width': {
          const limits = asLimits(event['limits'])
          if (typeof event['width'] === 'number' && limits !== null) edge.update({ side: root.dataset['side'] === 'left' ? 'left' : 'right', width: event['width'], limits })
          break
        }
        case 'side':
          if (event['side'] === 'left' || event['side'] === 'right') {
            root.dataset['side'] = event['side']
            document.body.dataset['side'] = event['side']
          }
          break
        case 'guests': guests = asGuests(event['guests']); draw(); break
      }
    })

    return {
      shown (payload) {
        const next: Shown | null = asShown(payload)
        if (next === null) return
        views = next.views
        guests = next.guests
        view = next.view
        guest = next.guest
        root.dataset['side'] = next.side
        document.body.dataset['side'] = next.side
        edge.update({ side: next.side, width: next.width, limits: next.limits })
        query = ''
        input.value = ''
        selected = null
        armed = null
        loading = false
        if (firstShow) {
          firstShow = false
          defaultOpen = next.defaultOpen
          open = new Set(defaultOpen)
        }
        raw = next.rows
        shown = withDays(raw, Date.now())
        if (open.size !== defaultOpen.length || defaultOpen.some((id) => !open.has(id))) fetchRows()
        draw()
        if (!inGuest()) input.focus()
      }
    }
  }
}
