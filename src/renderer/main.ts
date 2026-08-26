import type { ShellState, TabState } from '../main/tabs.js'

// The chrome view's whole job: render ShellState, turn clicks/typing into
// orivonShell.* commands. Main holds truth (src/main/tabs.ts) -- this file
// never guesses at tab state between pushes.

interface OrivonShell {
  newTab: (url?: string) => void
  closeTab: (id: string) => void
  activateTab: (id: string) => void
  navigate: (id: string, input: string) => void
  back: (id: string) => void
  forward: (id: string) => void
  reload: (id: string) => void
  onState: (listener: (state: ShellState) => void) => () => void
}

declare global {
  interface Window {
    orivonShell?: OrivonShell
  }
}

// TS control-flow narrowing does not persist into closures (event
// listener callbacks, functions declared below) even for `const`
// bindings that are never reassigned -- a plain `if (x === null) throw`
// here would still leave every later use flagged "possibly null". `must`
// makes the TYPE non-nullable at the source instead of relying on
// narrowing that doesn't survive past this point.
function must<T> (value: T | null | undefined, message: string): T {
  if (value === null || value === undefined) throw new Error(message)
  return value
}

const shell = must(window.orivonShell, 'orivonShell not exposed -- preload did not run')

const tabrow = must(document.querySelector<HTMLDivElement>('#tabrow'), '#tabrow missing')
const backBtn = must(document.querySelector<HTMLButtonElement>('#back'), '#back missing')
const forwardBtn = must(document.querySelector<HTMLButtonElement>('#forward'), '#forward missing')
const reloadBtn = must(document.querySelector<HTMLButtonElement>('#reload'), '#reload missing')
const newTabBtn = must(document.querySelector<HTMLButtonElement>('#new-tab'), '#new-tab missing')
const addressForm = must(document.querySelector<HTMLFormElement>('#address-form'), '#address-form missing')
const addressInput = must(document.querySelector<HTMLInputElement>('#address'), '#address missing')

const SVG_NS = 'http://www.w3.org/2000/svg'

/** Builds the close (x) icon via DOM APIs, not innerHTML -- this string is
 * static today, but a codebase this security-conscious about XSS
 * (security-model.md T1/T10/T12/T17) shouldn't carry the pattern even
 * where the current data happens to be safe. */
function closeIcon (): SVGSVGElement {
  const svg = document.createElementNS(SVG_NS, 'svg')
  svg.setAttribute('viewBox', '0 0 12 12')
  svg.setAttribute('aria-hidden', 'true')
  for (const [x1, y1, x2, y2] of [[2, 2, 10, 10], [10, 2, 2, 10]] as const) {
    const line = document.createElementNS(SVG_NS, 'line')
    line.setAttribute('x1', String(x1))
    line.setAttribute('y1', String(y1))
    line.setAttribute('x2', String(x2))
    line.setAttribute('y2', String(y2))
    line.setAttribute('stroke', 'currentColor')
    line.setAttribute('stroke-width', '1.3')
    svg.append(line)
  }
  return svg
}

/** True while the user is editing the address bar -- an incoming state
 * push must not clobber what they're typing. */
let addressFocused = false

function activeTab (state: ShellState): TabState | undefined {
  return state.tabs.find((t) => t.id === state.activeTabId)
}

function renderTabs (state: ShellState): void {
  tabrow.replaceChildren()
  for (const tab of state.tabs) {
    const el = document.createElement('div')
    el.className = 'tab'
    el.classList.toggle('active', tab.id === state.activeTabId)
    el.classList.toggle('loading', tab.loading)
    el.setAttribute('role', 'tab')
    el.setAttribute('aria-selected', String(tab.id === state.activeTabId))
    el.dataset['id'] = tab.id

    const fav = document.createElement('span')
    fav.className = 'fav'

    const title = document.createElement('span')
    title.className = 'title'
    title.textContent = tab.title.length > 0 ? tab.title : 'New Tab'

    const close = document.createElement('button')
    close.className = 'close'
    close.type = 'button'
    close.setAttribute('aria-label', `Close ${title.textContent}`)
    close.append(closeIcon())
    close.addEventListener('click', (e) => {
      e.stopPropagation()
      shell.closeTab(tab.id)
    })

    el.append(fav, title, close)
    el.addEventListener('click', () => shell.activateTab(tab.id))
    tabrow.append(el)
  }
}

function renderToolbar (state: ShellState): void {
  const active = activeTab(state)
  backBtn.disabled = active === undefined || !active.canGoBack
  forwardBtn.disabled = active === undefined || !active.canGoForward

  if (!addressFocused) {
    addressInput.value = active === undefined || active.url === 'about:blank' ? '' : active.url
  }
}

function render (state: ShellState): void {
  renderTabs(state)
  renderToolbar(state)
}

let currentState: ShellState = { tabs: [], activeTabId: null }
shell.onState((state) => {
  currentState = state
  render(state)
})

newTabBtn.addEventListener('click', () => shell.newTab())

backBtn.addEventListener('click', () => {
  if (currentState.activeTabId !== null) shell.back(currentState.activeTabId)
})
forwardBtn.addEventListener('click', () => {
  if (currentState.activeTabId !== null) shell.forward(currentState.activeTabId)
})
reloadBtn.addEventListener('click', () => {
  if (currentState.activeTabId !== null) shell.reload(currentState.activeTabId)
})

addressInput.addEventListener('focus', () => { addressFocused = true })
addressInput.addEventListener('blur', () => {
  addressFocused = false
  renderToolbar(currentState)
})
addressForm.addEventListener('submit', (e) => {
  e.preventDefault()
  if (currentState.activeTabId === null) return
  shell.navigate(currentState.activeTabId, addressInput.value)
  addressInput.blur()
})
