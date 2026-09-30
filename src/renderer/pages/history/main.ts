// The History page: the pages that were visited, newest first under a heading
// for each day, with a search, a button to forget one page, and one to forget
// everything. What is kept, and for how long, is set in Settings.
import type { HistoryEntry } from '../../../main/history/history-store.js'
import type { HistoryStatus } from '../../../main/history/history-service.js'
import { internalBridge } from '../shared/bridge.js'
import { h, replaceChildren } from '../shared/dom.js'
import { clockIcon, trashIcon } from '../shared/icons.js'
import { coalesce } from '../shared/coalesce.js'
import { groupByDay, timeLabel } from './days.js'
import { siteMark } from './site-mark.js'

const bridge = internalBridge()
const PAGE_SIZE = 100
const SEARCH_DELAY_MS = 200

interface ListReply {
  readonly entries: readonly HistoryEntry[]
  readonly status: HistoryStatus
}

let entries: HistoryEntry[] = []
let status: HistoryStatus | null = null
let more = false
let query = ''
let loading = false
/** A push arrived while the tab was not visible; caught up on visibilitychange instead of reloading (and redrawing, and losing scroll) work nobody could see. */
let pendingWhileHidden = false

const search = h('input', { className: 'text search', type: 'search', placeholder: 'Search history', autocomplete: 'off', spellcheck: false })
search.setAttribute('aria-label', 'Search history')
const countLine = h('p', { className: 'count', textContent: 'Loading…' })
const banner = h('div', { className: 'banner', hidden: true, role: 'status' })
const list = h('div', { className: 'list' })
const moreButton = h('button', { className: 'btn', type: 'button', textContent: 'Show more', hidden: true })
const clearAll = h('button', { className: 'btn danger', type: 'button', textContent: 'Clear all history' })

async function request (command: object): Promise<unknown> {
  return await bridge.request('history', command)
}

/** `limit` defaults to one page; a from-scratch reload that wants to keep
 * showing as much as was already loaded (see `reloadKeepingDepth` below)
 * asks for more. */
async function load (append: boolean, limit = PAGE_SIZE): Promise<void> {
  if (loading) return
  loading = true
  try {
    const last = append ? entries.at(-1) : undefined
    const reply = await request({ type: 'list', search: query, limit, ...(last === undefined ? {} : { after: { lastVisit: last.lastVisit, id: last.id } }) }) as ListReply
    entries = append ? [...entries, ...reply.entries] : [...reply.entries]
    status = reply.status
    more = reply.entries.length === limit
  } finally {
    loading = false
  }
  render()
}

/**
 * A change from elsewhere (a push, or catching up after being hidden) --
 * never a person's own action, which already knows how many entries it
 * wants. Re-fetches from the top, but asks for as many as were already
 * shown (never fewer than one page), so "Show more" is not silently
 * collapsed back to page one, and restores the scroll position `load`'s own
 * `replaceChildren` would otherwise leave to chance once the page's height
 * changes underneath it.
 *
 * IN PAGES OF `PAGE_SIZE`, NEVER ONE REQUEST FOR THE WHOLE DEPTH: asking
 * main for `depth` entries directly hits its own MAX_PAGE_SIZE clamp once
 * `depth` passes 500, and a reply shorter than what was asked reads as
 * "there is nothing more" -- collapsing "Show more" for good the first time
 * anyone has scrolled that deep. Fetching one ordinary page at a time keeps
 * every single request (and the `more` it reports) exactly as `load` already
 * handles it, however deep `depth` itself grows.
 */
async function reloadKeepingDepth (): Promise<void> {
  if (document.visibilityState !== 'visible') { pendingWhileHidden = true; return }
  const depth = Math.max(entries.length, PAGE_SIZE)
  const scrollY = window.scrollY
  await load(false, PAGE_SIZE)
  while (entries.length < depth && more) await load(true, PAGE_SIZE)
  window.scrollTo(0, scrollY)
}

function openSettings (): void {
  void bridge.request('pages', { type: 'open', page: 'settings', path: '/privacy' })
}

function renderBanner (): void {
  banner.hidden = true
  if (status === null) return
  if (status.problem !== null) {
    banner.hidden = false
    replaceChildren(banner, h('strong', { textContent: 'History is not being kept. ' }), 'The history file could not be opened. ',
      h('button', { className: 'link-btn', type: 'button', textContent: 'Details', onclick: openSettings }))
  } else if (!status.remembering) {
    banner.hidden = false
    replaceChildren(banner, h('strong', { textContent: 'History is off. ' }), 'New pages are not being remembered. ',
      h('button', { className: 'link-btn', type: 'button', textContent: 'Turn it on', onclick: openSettings }))
  }
}

function renderEntry (entry: HistoryEntry): HTMLElement {
  const remove = h('button', {
    className: 'remove',
    type: 'button',
    title: 'Remove this page from history',
    onclick: () => {
      void request({ type: 'remove', id: entry.id }).then(() => {
        entries = entries.filter((candidate) => candidate.id !== entry.id)
        render()
      })
    }
  }, trashIcon())
  remove.setAttribute('aria-label', `Remove ${entry.title === '' ? entry.url : entry.title} from history`)
  return h('div', { className: 'entry' },
    siteMark(entry.url),
    h('a', { className: 'target', href: entry.url, target: '_blank', rel: 'noopener' },
      h('span', { className: 'title', textContent: entry.title === '' ? entry.url : entry.title }),
      h('span', { className: 'url', textContent: entry.url })),
    h('span', { className: 'time', textContent: timeLabel(entry.lastVisit) }),
    remove)
}

function renderEmpty (): HTMLElement {
  return h('div', { className: 'empty' }, clockIcon(),
    h('p', { textContent: query === '' ? 'No pages yet. Pages you visit will show up here.' : `Nothing in your history matches "${query}".` }))
}

function render (): void {
  renderBanner()
  if (entries.length === 0) {
    replaceChildren(list, renderEmpty())
  } else {
    replaceChildren(list, ...groupByDay(entries, Date.now()).map((group) => h('section', { className: 'day' },
      h('h2', { textContent: group.label }),
      h('div', { className: 'entries' }, ...group.entries.map(renderEntry)))))
  }
  moreButton.hidden = !more
  clearAll.disabled = entries.length === 0 && query === ''
  countLine.textContent = status === null ? 'Loading…' : `${status.count.toLocaleString()} ${status.count === 1 ? 'page' : 'pages'} kept`
}

let searchTimer: ReturnType<typeof setTimeout> | undefined
search.addEventListener('input', () => {
  if (searchTimer !== undefined) clearTimeout(searchTimer)
  searchTimer = setTimeout(() => {
    query = search.value.trim()
    void load(false)
  }, SEARCH_DELAY_MS)
})
moreButton.addEventListener('click', () => { void load(true) })

let disarm: ReturnType<typeof setTimeout> | undefined
clearAll.addEventListener('click', () => {
  if (disarm === undefined) {
    clearAll.textContent = 'Click again to clear'
    clearAll.classList.add('armed')
    disarm = setTimeout(() => {
      disarm = undefined
      clearAll.textContent = 'Clear all history'
      clearAll.classList.remove('armed')
    }, 4000)
    return
  }
  clearTimeout(disarm)
  disarm = undefined
  clearAll.textContent = 'Clear all history'
  clearAll.classList.remove('armed')
  void request({ type: 'clear' }).then(async () => { await load(false) })
})

// The page is a tab like any other: a push that arrived while it was hidden
// (see reloadKeepingDepth) is caught up on here, once, rather than doing that
// work -- a data reload, a redraw, a scroll restore -- while nobody could see
// any of it happen.
document.addEventListener('visibilitychange', () => {
  if (document.visibilityState !== 'visible' || !pendingWhileHidden) return
  pendingWhileHidden = false
  void reloadKeepingDepth()
})

// A visit, a removal or a clear -- from this tab or another one open on the
// same page -- while History sits visible. Coalesced so a fast run of
// navigations reloads at most about once a second, not once per visit.
const reloadOnPush = coalesce(reloadKeepingDepth)
bridge.onEvent((topic) => { if (topic === 'history.changed') reloadOnPush() })

document.getElementById('app')?.append(
  h('main', { className: 'page' },
    h('header', { className: 'head' },
      h('h1', null, clockIcon(), 'History'),
      countLine),
    h('div', { className: 'toolbar' },
      search,
      h('div', { className: 'toolbar-right' },
        h('button', { className: 'btn', type: 'button', textContent: 'Clear browsing data…', onclick: openSettings }),
        clearAll)),
    banner,
    list,
    h('div', { className: 'more' }, moreButton)))

void load(false)
