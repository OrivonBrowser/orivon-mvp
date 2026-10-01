// The History page: the pages that were visited, under a heading for each day or session or in a sorted list,
// with a search, site icons, rows that can be chosen and opened or forgotten by key or mouse, and the tabs
// closed a moment ago. What is kept, and for how long, is set in Settings.
import type { HistoryEntry } from '../../../main/history/history-store.js'
import type { HistoryStatus } from '../../../main/history/history-service.js'
import { internalBridge } from '../shared/bridge.js'
import { h, replaceChildren } from '../shared/dom.js'
import { clockIcon } from '../shared/icons.js'
import { coalesce } from '../shared/coalesce.js'
import * as selection from '../shared/list-selection.js'
import { createClearAll } from './clear-all.js'
import { createControls } from './controls.js'
import { buildLayout } from './layout.js'
import { installKeys } from './page-keys.js'
import { closeRowMenu, openRowMenu } from '../shared/row-menu.js'
import { renderSelectionBar, OPEN_ALL_LIMIT } from './selection-bar.js'
import { PAGE_SIZE, state, visible } from './state.js'
import { unpackEntries } from './unpack.js'
import type { PackedRow } from './unpack.js'
import { renderClosed } from './view-closed.js'
import type { ClosedRow } from './view-closed.js'
import { renderBanner, renderEmpty } from './view-status.js'
import { applyRoving, renderSections, rowElement } from './view-rows.js'
import type { Disposition, RowActions } from './view-rows.js'

const bridge = internalBridge()
const SEARCH_DELAY_MS = 200
const ARMED_MS = 4000
const REMOVE_BATCH = 500

const search = h('input', { className: 'text search', type: 'search', placeholder: 'Search history', autocomplete: 'off', spellcheck: false })
search.setAttribute('aria-label', 'Search history')
const countLine = h('p', { className: 'count', textContent: 'Loading…' })
const banner = h('div', { className: 'banner', hidden: true, role: 'status' })
const closedHost = h('div', { className: 'closed-host' })
const barHost = h('div', { className: 'bar-host' })
const list = h('div', { className: 'list' })
const moreButton = h('button', { className: 'btn', type: 'button', hidden: true })
const clearAll = createClearAll(() => { void request({ type: 'clear' }).then(async () => { await load(false) }) })
const controls = createControls((grouping) => { state.grouping = grouping; render() }, (order) => { state.order = order; void load(false) })

/** A push that arrived while the tab was not visible; caught up on visibilitychange instead of redrawing work nobody could see. */
let pendingWhileHidden = false
let generation = 0
let disarm: ReturnType<typeof setTimeout> | undefined

const request = async (command: object): Promise<unknown> => await bridge.request('history', command)

interface ListReply { readonly entries: readonly PackedRow[], readonly icons: readonly string[], readonly status: HistoryStatus }

/** `limit` is one page unless a reload wants to keep as much on screen as was already loaded. A newer load makes an older reply stale. */
async function load (append: boolean, limit = PAGE_SIZE): Promise<void> {
  if (append && state.loadingMore) return
  const mine = append ? generation : ++generation
  const last = append ? state.entries.at(-1) : undefined
  const place = state.order === 'recent'
    ? (last === undefined ? {} : { after: { lastVisit: last.lastVisit, id: last.id } })
    : { offset: append ? state.entries.length : 0 }
  if (append) { state.loadingMore = true; renderMore() }
  try {
    const reply = await request({ type: 'list', search: state.query, limit, order: state.order, ...place }) as ListReply
    if (mine !== generation) return
    const entries = unpackEntries(reply.entries, reply.icons)
    state.entries = append ? [...state.entries, ...entries] : entries
    state.status = reply.status
    state.more = reply.entries.length === limit
  } finally {
    if (append) state.loadingMore = false
  }
  render()
}

/** A change from elsewhere: fetched again from the top, in pages, as deep as was shown, with the scroll kept. */
async function reloadKeepingDepth (): Promise<void> {
  if (document.visibilityState !== 'visible') { pendingWhileHidden = true; return }
  const depth = Math.max(state.entries.length, PAGE_SIZE)
  const scrollY = window.scrollY
  await load(false)
  for (let before = -1; state.entries.length < depth && state.more && state.entries.length !== before;) {
    before = state.entries.length
    await load(true)
  }
  window.scrollTo(0, scrollY)
}

async function loadClosed (): Promise<void> {
  const reply = await request({ type: 'closed' }) as { rows?: ClosedRow[] } | undefined
  state.closed = reply?.rows ?? []
  renderClosedCard()
}

function openSettings (): void {
  void bridge.request('pages', { type: 'open', page: 'settings', path: '/privacy' })
}

function setSelection (next: Set<number>): void {
  state.selected = next
  state.armed = false
}

function arm (): void {
  state.armed = true
  clearTimeout(disarm)
  disarm = setTimeout(() => { state.armed = false; render() }, ARMED_MS)
}

async function removeRows (ids: readonly number[]): Promise<void> {
  const gone = new Set(ids)
  const next = selection.focusAfterRemoval(visible(), gone, state.focusId)
  let status: HistoryStatus | undefined
  for (let from = 0; from < ids.length; from += REMOVE_BATCH) {
    const batch = ids.slice(from, from + REMOVE_BATCH)
    const reply = await request(batch.length === 1 ? { type: 'remove', id: batch[0] } : { type: 'removeMany', ids: batch }) as { status?: HistoryStatus } | undefined
    if (reply === undefined) return
    status = reply.status ?? status
  }
  state.entries = state.entries.filter((entry) => !gone.has(entry.id))
  setSelection(new Set([...state.selected].filter((id) => !gone.has(id))))
  state.focusId = next
  if (status !== undefined) state.status = status
  render(true)
}

const open = (entry: HistoryEntry, disposition: Disposition): void => { void request({ type: 'open', id: entry.id, disposition }) }
const entryById = (id: number): HistoryEntry | undefined => state.entries.find((entry) => entry.id === id)

function moreFromSite (entry: HistoryEntry): void {
  try {
    search.value = new URL(entry.url).hostname
  } catch {
    return
  }
  state.query = search.value
  void load(false)
}

const rowActions: RowActions = {
  open,
  toggle: (entry, extend) => {
    if (extend) setSelection(selection.range(visible(), state.anchor ?? state.focusId, entry.id))
    else { setSelection(selection.toggle(state.selected, entry.id)); state.anchor = entry.id }
    state.focusId = entry.id
    render(true)
  },
  menu: (entry, place, opener) => {
    openRowMenu([
      { label: 'Open in new tab', run: () => { open(entry, 'newTab') } },
      { label: 'Open in new window', run: () => { open(entry, 'window') } },
      { label: 'Copy link', run: () => { void request({ type: 'copy', id: entry.id }) } },
      { label: 'More from this site', run: () => { moreFromSite(entry) } },
      { label: 'Remove from history', danger: true, run: () => { void removeRows([entry.id]) } }
    ], place, () => { (opener?.isConnected === true ? opener : rowElement(list, entry.id))?.focus() })
  },
  remove: (entry) => { void removeRows([entry.id]) },
  collapse: (key) => {
    if (!state.collapsed.delete(key)) state.collapsed.add(key)
    render()
    list.querySelector<HTMLElement>(`.session-head[data-key="${String(key)}"]`)?.focus()
  }
}

/** What the card last drew, so a redraw of the list does not take the focus out of it. */
let closedDrawn = ''
function renderClosedCard (): void {
  const rows = state.query === '' ? state.closed : []
  const signature = JSON.stringify(rows)
  if (signature === closedDrawn) return
  closedDrawn = signature
  replaceChildren(closedHost, renderClosed(rows, Date.now(), (id) => { void reopen(id) }))
}

async function reopen (id: number): Promise<void> {
  await request({ type: 'reopen', id })
  void loadClosed()
}

function renderMore (): void {
  moreButton.hidden = !state.more
  moreButton.disabled = state.loadingMore
  replaceChildren(moreButton, state.loadingMore ? h('span', { className: 'spinner' }) : null, 'Show more')
}

/** `focus`: put the focus on the row the keys act on, as after a choice or a delete. Otherwise it stays where it was. */
function render (focus = false): void {
  const active = document.activeElement as HTMLElement | null
  const listHadFocus = list.contains(active)
  const barHadFocus = barHost.contains(active)
  renderBanner(banner, state.status, openSettings)
  state.sections = buildLayout({ entries: state.entries, order: state.order, grouping: state.grouping, collapsed: state.collapsed, now: Date.now() })
  const ids = visible()
  state.selected = new Set([...state.selected].filter((id) => entryById(id) !== undefined))
  if (state.selected.size === 0) { state.anchor = null; state.armed = false }
  if (state.focusId === null || !ids.includes(state.focusId)) state.focusId = ids[0] ?? null
  const view = { selected: state.selected, showVisits: state.order === 'visits', showDate: state.order !== 'recent', now: Date.now() }
  replaceChildren(list, state.entries.length === 0 ? renderEmpty(state.query) : h('div', { className: 'sections' }, ...renderSections(state.sections, view, rowActions)))
  list.classList.toggle('selecting', state.selected.size > 0)
  applyRoving(list, state.focusId)
  replaceChildren(barHost, state.selected.size === 0 ? null : renderSelectionBar(state.selected.size, state.armed, {
    openAll: () => {
      void request({ type: 'openMany', ids: ids.filter((id) => state.selected.has(id)).slice(0, OPEN_ALL_LIMIT) })
      setSelection(new Set())
      render()
    },
    remove: () => { if (state.armed) void removeRows([...state.selected]); else { arm(); render() } },
    cancel: () => { setSelection(new Set()); render(true) }
  }))
  if (focus || listHadFocus) rowElement(list, state.focusId)?.focus()
  else if (barHadFocus) barHost.querySelector<HTMLElement>('[data-action="delete"]')?.focus()
  controls.sync(state.grouping, state.order)
  renderMore()
  renderClosedCard()
  clearAll.disabled = state.entries.length === 0 && state.query === ''
  countLine.textContent = state.status === null ? 'Loading…' : `${state.status.count.toLocaleString()} ${state.status.count === 1 ? 'page' : 'pages'} kept`
}

function clearSearch (): void {
  clearTimeout(searchTimer)
  search.value = ''
  state.query = ''
  void load(false)
}

let searchTimer: ReturnType<typeof setTimeout> | undefined
search.addEventListener('input', () => {
  clearTimeout(searchTimer)
  searchTimer = setTimeout(() => { state.query = search.value.trim(); void load(false) }, SEARCH_DELAY_MS)
})
moreButton.addEventListener('click', () => { void load(true) })
list.addEventListener('focusin', (event) => {
  const row = (event.target as HTMLElement).closest<HTMLElement>('.entry')
  if (row === null) return
  state.focusId = Number(row.dataset['id'])
  applyRoving(list, state.focusId)
})

installKeys({
  search,
  mac: bridge.platform === 'darwin',
  clearSearch,
  clearSelection: () => { closeRowMenu(); setSelection(new Set()); render(true) },
  hasSelection: () => state.selected.size > 0,
  focusSearch: () => { search.focus(); search.select() },
  move: (id, to, extend) => {
    const next = selection.step(visible(), id, to)
    if (next === null) return
    if (extend) {
      setSelection(selection.range(visible(), state.anchor ?? id, next))
      state.anchor ??= id
    }
    state.focusId = next
    if (extend) { render(true) } else { applyRoving(list, next) }
    const row = rowElement(list, next)
    row?.focus()
    row?.scrollIntoView({ block: 'nearest' })
  },
  open: (id, disposition) => { const entry = entryById(id); if (entry !== undefined) open(entry, disposition) },
  toggle: (id) => { setSelection(selection.toggle(state.selected, id)); state.anchor = id; state.focusId = id; render(true) },
  selectAll: () => { setSelection(selection.all(visible())); render() },
  remove: (id) => {
    const ids = state.selected.has(id) ? [...state.selected] : [id]
    if (ids.length > 1 && !state.armed) { arm(); render() } else void removeRows(ids)
  }
})

document.addEventListener('visibilitychange', () => {
  if (document.visibilityState !== 'visible' || !pendingWhileHidden) return
  pendingWhileHidden = false
  void reloadKeepingDepth()
})

// A visit, a removal or a clear -- from this tab or another one open on the same page -- while History sits visible.
// Coalesced so a fast run of navigations reloads at most about once a second, not once per visit.
const reloadOnPush = coalesce(reloadKeepingDepth)
const reloadClosedOnPush = coalesce(() => { void loadClosed() }, 250)
bridge.onEvent((topic) => {
  if (topic === 'history.changed') reloadOnPush()
  else if (topic === 'history.closed') reloadClosedOnPush()
})

document.getElementById('app')?.append(
  h('main', { className: 'page' },
    h('header', { className: 'head' }, h('h1', null, clockIcon(), 'History')),
    h('div', { className: 'toolbar' },
      search,
      h('div', { className: 'toolbar-right' },
        h('button', { className: 'btn', type: 'button', textContent: 'Clear browsing data…', onclick: openSettings }),
        clearAll)),
    h('div', { className: 'view-bar' }, controls.element, countLine),
    banner,
    closedHost,
    h('div', { className: 'list-wrap' }, barHost, list),
    h('div', { className: 'more' }, moreButton)))

void load(false)
void loadClosed()
