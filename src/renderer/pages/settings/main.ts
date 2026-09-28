// The Settings page: a list of sections down the side, one section's rows in
// the middle, and a search box that finds any row. Every address is a place in
// it (`orivon://settings/search`), so the address bar always says where the
// person is and a link goes straight to a section.
import { h, replaceChildren } from '../shared/dom.js'
import type { Row, Section } from './model.js'
import { pathFor, placeFor } from './router.js'
import { renderRow } from './rows.js'
import { searchRows } from './search.js'
import { SECTIONS } from './sections/index.js'
import { SettingsState } from './state.js'

const state = new SettingsState()

const isShown = (row: Row): boolean => row.visible?.(state) ?? true

const nav = h('ul', { className: 'nav-list' })
const content = h('main', { className: 'content', tabIndex: -1 })
const search = h('input', { className: 'text search', type: 'search', placeholder: 'Search settings', autocomplete: 'off', spellcheck: false })
search.setAttribute('aria-label', 'Search settings')

let current: Section = placeFor(location.pathname, SECTIONS).section
let highlight: string | null = null

function renderSectionBody (section: Section): HTMLElement {
  const rows = section.rows.filter(isShown).map((row) => renderRow(row, state))
  return h('section', { className: 'section' },
    h('h2', { textContent: section.title }),
    section.intro === undefined ? null : h('p', { className: 'intro', textContent: section.intro }),
    h('div', { className: 'card' }, ...rows))
}

function renderSearchBody (query: string): HTMLElement {
  const hits = searchRows(SECTIONS, query, isShown)
  if (hits.length === 0) return h('p', { className: 'empty', textContent: `Nothing in Settings matches "${query}".` })
  return h('section', { className: 'section' },
    h('h2', { textContent: `${String(hits.length)} ${hits.length === 1 ? 'result' : 'results'}` }),
    h('div', { className: 'card' }, ...hits.map(({ section, row }) => h('button', {
      className: 'hit',
      type: 'button',
      onclick: () => { go(section, row.id) }
    },
    h('span', { className: 'hit-section', textContent: section.title }),
    h('span', { className: 'hit-label', textContent: row.label }),
    row.help === undefined ? null : h('span', { className: 'hit-help', textContent: row.help })))))
}

function renderNav (): void {
  replaceChildren(nav, ...SECTIONS.map((section) => h('li', null, h('a', {
    className: section.id === current.id && search.value.trim() === '' ? 'nav-item current' : 'nav-item',
    href: pathFor(section),
    textContent: section.title,
    onclick: (event: MouseEvent) => { event.preventDefault(); go(section) }
  }))))
}

function render (): void {
  const query = search.value.trim()
  renderNav()
  replaceChildren(content, query === '' ? renderSectionBody(current) : renderSearchBody(query))
  if (highlight !== null) {
    const row = document.getElementById(`row-${highlight}`)
    row?.scrollIntoView({ block: 'center' })
    row?.classList.add('flash')
    highlight = null
  }
}

/** Shows a section, optionally scrolled to and marking one of its rows. */
function go (section: Section, rowId?: string): void {
  current = section
  search.value = ''
  if (location.pathname !== pathFor(section)) history.pushState(null, '', pathFor(section))
  highlight = rowId ?? null
  render()
  if (rowId === undefined) content.scrollTop = 0
}

async function start (): Promise<void> {
  await state.load()
  search.addEventListener('input', render)
  search.addEventListener('keydown', (event) => {
    if (event.key === 'Escape' && search.value !== '') {
      search.value = ''
      render()
    }
  })
  window.addEventListener('keydown', (event) => {
    const target = event.target as HTMLElement
    if (event.key === '/' && !event.ctrlKey && !event.metaKey && !event.altKey && target.closest('input, select, textarea') === null) {
      event.preventDefault()
      search.focus()
    }
  })
  window.addEventListener('popstate', () => {
    current = placeFor(location.pathname, SECTIONS).section
    search.value = ''
    render()
  })

  // A change made elsewhere, or by a control here, redraws the page; but not
  // under a text box the person is typing in.
  state.onChange(() => {
    if (document.activeElement instanceof HTMLInputElement && document.activeElement.type === 'text' && content.contains(document.activeElement)) return
    render()
  })

  const place = placeFor(location.pathname, SECTIONS)
  if (place.canonicalPath !== null) history.replaceState(null, '', place.canonicalPath)

  document.getElementById('app')?.append(
    h('div', { className: 'layout' },
      h('header', { className: 'top' }, h('h1', { textContent: 'Settings' }), search),
      h('nav', { className: 'nav' }, nav),
      content))
  render()
}

void start()
