// The Extensions page: a header with two tabs, and the view the address
// names (router.ts) from the registry (registry.ts). Every address is a place
// in the page (`orivon://extensions/details?id=...`), so the address bar says
// where the person is and a link goes straight to it.
import { h, replaceChildren } from '../shared/dom.js'
import { pathFor, placeFor } from './router.js'
import type { Place, ViewName } from './router.js'
import { EXTENSION_VIEWS } from './registry.js'
import { PageState } from './state.js'
import type { PageContext } from './types.js'

const state = new PageState()

const TABS: ReadonlyArray<{ readonly view: ViewName, readonly label: string }> = [
  { view: 'list', label: 'My extensions' },
  { view: 'shortcuts', label: 'Keyboard shortcuts' }
]

const tabLinks = TABS.map((tab) => h('a', {
  className: 'tab-btn',
  href: pathFor(tab.view),
  textContent: tab.label,
  role: 'tab',
  onclick: (event: MouseEvent) => { event.preventDefault(); navigate(pathFor(tab.view)) }
}))
const tabs = h('nav', { className: 'tabs', role: 'tablist' }, ...tabLinks)
tabs.setAttribute('aria-label', 'Extensions')
const content = h('div', { className: 'view' })

let place: Place = placeFor(location.pathname, location.search)

function context (): PageContext {
  return {
    request: async <T>(type: string, body?: object) => await state.request<T>(type, body),
    navigate,
    refresh: () => { show(false) },
    developerMode: state.developerMode,
    isPrivate: state.isPrivate
  }
}

function markTabs (): void {
  tabLinks.forEach((link, index) => {
    const selected = (TABS[index]?.view === 'shortcuts') === (place.view === 'shortcuts')
    link.setAttribute('aria-selected', String(selected))
    if (selected) link.setAttribute('aria-current', 'page')
    else link.removeAttribute('aria-current')
  })
}

/** `fresh` empties the view first, for a new place; a refresh keeps what is on screen until the new data arrives. */
function show (fresh: boolean): void {
  markTabs()
  if (fresh) replaceChildren(content)
  EXTENSION_VIEWS[place.view].render(content, context())
}

function navigate (path: string): void {
  const url = new URL(path, location.href)
  history.pushState(null, '', `${url.pathname}${url.search}`)
  place = placeFor(url.pathname, url.search)
  show(true)
  window.scrollTo(0, 0)
}

async function start (): Promise<void> {
  replaceChildren(document.getElementById('app') as HTMLElement,
    h('main', { className: 'page' }, h('header', { className: 'head' }, h('h1', { textContent: 'Extensions' })), tabs, content))
  await state.load()
  if (place.canonical !== null) history.replaceState(null, '', place.canonical)
  show(true)
  window.addEventListener('popstate', () => {
    place = placeFor(location.pathname, location.search)
    show(true)
  })
  state.onChange(() => { show(false) })
}

void start()
