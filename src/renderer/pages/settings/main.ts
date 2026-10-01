// The Settings page: a list of sections down the side, one section's rows in
// the middle, and a search box that finds any row. Every address is a place in
// it (`orivon://settings/search`), so the address bar always says where the
// person is and a link goes straight to a section.
import { gearIcon } from '../shared/icons.js'
import { h, replaceChildren } from '../shared/dom.js'
import { onArmEnded } from '../shared/armed.js'
import type { Row, Section } from './model.js'
import { groupLabelFor, NAV_ICON } from './nav.js'
import { pathFor, placeFor } from './router.js'
import { renderRow } from './rows.js'
import { searchRows } from './search.js'
import { sectionsFor } from './sections/index.js'
import { SettingsState } from './state.js'

const state = new SettingsState()

const isShown = (row: Row): boolean => row.visible?.(state) ?? true

const nav = h('ul', { className: 'nav-list' })
const content = h('main', { className: 'content', tabIndex: -1 })
const search = h('input', { className: 'text search', type: 'search', placeholder: 'Search settings', autocomplete: 'off', spellcheck: false })
search.setAttribute('aria-label', 'Search settings')

// Set once the state has loaded: some sections are built from what main reports.
let sections: readonly Section[] = []
let current: Section = { id: '', title: '', rows: [] }
let highlight: string | null = null

/** A section's rows, one `.card` per group when its rows carry one (a muted
 * heading above each card, reading the way the sidebar's own group labels
 * do), or one card for the whole section when none of its rows do. */
function renderRows (rows: readonly Row[]): HTMLElement[] {
  if (!rows.some((row) => row.group !== undefined)) return [h('div', { className: 'card' }, ...rows.map((row) => renderRow(row, state)))]
  const out: HTMLElement[] = []
  let group: string | undefined
  let inGroup: HTMLElement[] = []
  const flush = (): void => { if (inGroup.length > 0) out.push(h('div', { className: 'card' }, ...inGroup)) }
  for (const row of rows) {
    if (row.group !== group) {
      flush()
      inGroup = []
      group = row.group
      if (group !== undefined) out.push(h('h3', { className: 'group-label', textContent: group }))
    }
    inGroup.push(renderRow(row, state))
  }
  flush()
  return out
}

function renderSectionBody (section: Section): HTMLElement {
  return h('section', { className: 'section' },
    h('h2', { textContent: section.title }),
    section.intro === undefined ? null : h('p', { className: 'intro', textContent: section.intro }),
    ...renderRows(section.rows.filter(isShown)))
}

function renderSearchBody (query: string): HTMLElement {
  const hits = searchRows(sections, query, isShown)
  if (hits.length === 0) return h('p', { className: 'empty', textContent: `Nothing in Settings matches "${query}".` })
  return h('section', { className: 'section' },
    h('h2', { textContent: `${String(hits.length)} ${hits.length === 1 ? 'result' : 'results'}` }),
    h('div', { className: 'card' }, ...hits.map(({ section, row }) => h('button', {
      className: 'hit',
      type: 'button',
      onclick: () => { go(section, row.id) }
    },
    h('div', { className: 'hit-body' },
      h('span', { className: 'hit-label', textContent: row.label }),
      row.help === undefined ? null : h('span', { className: 'hit-help', textContent: row.help })),
    h('span', { className: 'hit-section', textContent: section.title })))))
}

/** The sidebar list: a muted group heading before the first section of each
 * group, then the section itself, icon and label together in its `.nav-item`. */
function renderNav (): void {
  const items: HTMLElement[] = []
  let previous: Section | undefined
  for (const section of sections) {
    const groupLabel = groupLabelFor(section, previous)
    if (groupLabel !== null) items.push(h('li', { className: 'nav-group', textContent: groupLabel }))
    const drawIcon = NAV_ICON[section.id]
    items.push(h('li', null, h('a', {
      className: section.id === current.id && search.value.trim() === '' ? 'nav-item current' : 'nav-item',
      href: pathFor(section),
      onclick: (event: MouseEvent) => { event.preventDefault(); go(section) }
    }, drawIcon === undefined ? null : drawIcon(), h('span', { className: 'nav-label', textContent: section.title }))))
    previous = section
  }
  replaceChildren(nav, ...items)
}

function render (): void {
  const query = search.value.trim()
  // A choice that was just made keeps the keyboard, so the row is found again in the new page.
  const focusedChoice = document.activeElement instanceof HTMLSelectElement ? document.activeElement.closest('.row')?.id : undefined
  // A control that keeps its nodes across redraws (`data-keep-focus`) takes the keyboard back by reference.
  const kept = document.activeElement instanceof HTMLElement && document.activeElement.closest('[data-keep-focus]') !== null ? document.activeElement : null
  renderNav()
  replaceChildren(content, query === '' ? renderSectionBody(current) : renderSearchBody(query))
  if (focusedChoice !== undefined) document.getElementById(focusedChoice)?.querySelector('select')?.focus()
  if (kept?.isConnected === true) kept.focus()
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

/** An address ending `#<row id>` (Clear browsing data's shortcut) shows that row, marks it and gives it the keyboard. The hash is then dropped, so asking for the same row again is a new navigation. */
function showRowFromHash (): void {
  const id = decodeURIComponent(location.hash.slice(1))
  if (id === '') return
  history.replaceState(null, '', location.pathname)
  const found = sections.flatMap((section) => section.rows.filter(isShown).map((row) => ({ section, row }))).find(({ row }) => row.id === id)
  if (found === undefined) return
  go(found.section, found.row.id)
  document.getElementById(`row-${id}`)?.querySelector<HTMLElement>('input, select, button')?.focus()
}

async function start (): Promise<void> {
  await state.load()
  sections = sectionsFor(state)
  current = placeFor(location.pathname, sections).section
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
    current = placeFor(location.pathname, sections).section
    search.value = ''
    render()
  })

  // A change made elsewhere, or by a control here, redraws the page; but not
  // while the person is in the middle of something a redraw would throw
  // away: typing, a focused control (a <select> a redraw would otherwise
  // silently close), or a two-click confirm armed and waiting for its
  // second click (clear-data.ts's own "Click again to clear", the only
  // `.armed` button in Settings today, and any future one the same way).
  //
  // NEVER DROPPED: a checkbox or a <select> keeps focus after it is used
  // (unlike a text box, which a person usually leaves promptly), so a push
  // that arrived while one had focus could otherwise wait forever. Held as
  // `renderPending` instead, and re-tried on `focusout` and whenever an
  // armed confirm ends -- the same shape ../profiles/main.ts's own
  // `reloadPending`/`reloadUnlessBusy` already use for the identical hazard.
  function midInteraction (): boolean {
    const active = document.activeElement
    if (!(content.contains(active))) return false
    // A control that has taken its value and needs the page drawn again says so; a half-typed one does not.
    if ((active instanceof HTMLInputElement || active instanceof HTMLTextAreaElement || active instanceof HTMLSelectElement) && active.dataset['settled'] !== 'true') return true
    return content.querySelector('.armed') !== null
  }
  let renderPending = false
  function renderUnlessBusy (): void {
    if (!renderPending || midInteraction()) return
    renderPending = false
    render()
  }
  state.onChange(() => {
    renderPending = true
    renderUnlessBusy()
  })
  // A blur can fire just before the new element takes focus; deferred one
  // tick so `document.activeElement` already reflects where focus landed.
  document.addEventListener('focusout', () => { setTimeout(renderUnlessBusy) })
  onArmEnded(renderUnlessBusy)

  const place = placeFor(location.pathname, sections)
  if (place.canonicalPath !== null) history.replaceState(null, '', place.canonicalPath)

  document.getElementById('app')?.append(
    h('div', { className: 'layout' },
      h('nav', { className: 'sidebar' },
        h('div', { className: 'sidebar-head' }, gearIcon(), h('h1', { textContent: 'Settings' })),
        search,
        h('div', { className: 'nav-scroll' }, nav)),
      content))
  render()
  showRowFromHash()
  window.addEventListener('hashchange', showRowFromHash)
}

void start()
