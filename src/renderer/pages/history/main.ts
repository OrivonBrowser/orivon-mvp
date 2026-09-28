// The History page: the pages that were visited, newest first under a heading
// for each day, with a search, a button to forget one page, and one to forget
// everything. What is kept, and for how long, is set in Settings.
import type { HistoryEntry } from '../../../main/history/history-store.js'
import type { HistoryStatus } from '../../../main/history/history-service.js'
import { internalBridge } from '../shared/bridge.js'
import { h, replaceChildren } from '../shared/dom.js'
import { groupByDay, timeLabel } from './days.js'

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

const search = h('input', { className: 'text search', type: 'search', placeholder: 'Search history', autocomplete: 'off', spellcheck: false })
search.setAttribute('aria-label', 'Search history')
const banner = h('div', { className: 'banner', hidden: true, role: 'status' })
const list = h('div', { className: 'list' })
const moreButton = h('button', { className: 'btn', type: 'button', textContent: 'Show more', hidden: true })
const clearAll = h('button', { className: 'btn danger', type: 'button', textContent: 'Clear all history' })

async function request (command: object): Promise<unknown> {
  return await bridge.request('history', command)
}

async function load (append: boolean): Promise<void> {
  if (loading) return
  loading = true
  try {
    const last = append ? entries.at(-1) : undefined
    const reply = await request({ type: 'list', search: query, ...(last === undefined ? {} : { after: { lastVisit: last.lastVisit, id: last.id } }) }) as ListReply
    entries = append ? [...entries, ...reply.entries] : [...reply.entries]
    status = reply.status
    more = reply.entries.length === PAGE_SIZE
  } finally {
    loading = false
  }
  render()
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
    textContent: '×',
    onclick: () => {
      void request({ type: 'remove', id: entry.id }).then(() => {
        entries = entries.filter((candidate) => candidate.id !== entry.id)
        render()
      })
    }
  })
  remove.setAttribute('aria-label', `Remove ${entry.title === '' ? entry.url : entry.title} from history`)
  return h('div', { className: 'entry' },
    h('span', { className: 'time', textContent: timeLabel(entry.lastVisit) }),
    h('a', { className: 'target', href: entry.url, target: '_blank', rel: 'noopener' },
      h('span', { className: 'title', textContent: entry.title === '' ? entry.url : entry.title }),
      h('span', { className: 'url', textContent: entry.url })),
    remove)
}

function render (): void {
  renderBanner()
  if (entries.length === 0) {
    replaceChildren(list, h('p', { className: 'empty', textContent: query === '' ? 'No pages yet. Pages you visit will show up here.' : `Nothing in your history matches "${query}".` }))
  } else {
    replaceChildren(list, ...groupByDay(entries, Date.now()).map((group) => h('section', { className: 'day' },
      h('h2', { textContent: group.label }),
      h('div', { className: 'card' }, ...group.entries.map(renderEntry)))))
  }
  moreButton.hidden = !more
  clearAll.disabled = entries.length === 0 && query === ''
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

// The page is a tab like any other: come back to it and it shows what has happened since.
document.addEventListener('visibilitychange', () => {
  if (document.visibilityState === 'visible') void load(false)
})

document.getElementById('app')?.append(
  h('main', { className: 'page' },
    h('header', { className: 'head' },
      h('h1', { textContent: 'History' }),
      search,
      h('button', { className: 'btn', type: 'button', textContent: 'Clear browsing data…', onclick: openSettings }),
      clearAll),
    banner,
    list,
    h('div', { className: 'more' }, moreButton)))

void load(false)
