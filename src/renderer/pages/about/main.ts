// The About page: the version table at `/`, the graphics report at `/gpu`,
// both as real addresses so the address bar says which one is showing.
import { h, replaceChildren } from '../shared/dom.js'
import { AboutState } from './state.js'
import { gpuBody, versionBody } from './view.js'

type Tab = 'version' | 'gpu'

const COPIED_MS = 2_000

const state = new AboutState()

function tabFor (pathname: string): Tab {
  return pathname.split('/').filter((part) => part !== '')[0] === 'gpu' ? 'gpu' : 'version'
}

let current: Tab = tabFor(location.pathname)

const version = h('p', { className: 'version', textContent: '' })
const copyButton = h('button', { className: 'link-btn', type: 'button', textContent: 'Copy details' })
const body = h('div', { className: 'body' })
const tabs = (['version', 'gpu'] as const).map((tab) => h('a', {
  className: 'tab-btn',
  href: tab === 'version' ? '/' : '/gpu',
  textContent: tab === 'version' ? 'Version' : 'Graphics',
  role: 'tab',
  onclick: (event) => {
    event.preventDefault()
    go(tab)
  }
}))

/** Shows "Copied" on a button for a moment, then what it said before. */
function flash (button: HTMLButtonElement, label: string, done: boolean): void {
  button.textContent = done ? 'Copied' : 'Could not copy'
  setTimeout(() => { button.textContent = label }, COPIED_MS)
}

function render (): void {
  tabs.forEach((link, index) => {
    const selected = (index === 0 ? 'version' : 'gpu') === current
    link.setAttribute('aria-selected', String(selected))
    if (selected) link.setAttribute('aria-current', 'page')
    else link.removeAttribute('aria-current')
  })
  const row = state.version.state === 'ready' ? state.version.value[0] : undefined
  version.textContent = row === undefined ? '' : `Version ${row.value}`
  replaceChildren(body, current === 'version'
    ? versionBody(state)
    : gpuBody(state, () => { void state.loadGpu() }, (button) => {
      void state.copy('gpu').then((ok) => { flash(button, 'Copy', ok) })
    }))
}

function go (tab: Tab): void {
  current = tab
  const path = tab === 'version' ? '/' : '/gpu'
  if (location.pathname !== path) history.pushState(null, '', path)
  if (tab === 'gpu' && state.gpu === null) void state.loadGpu()
  render()
}

copyButton.onclick = () => {
  void state.copy('version').then((ok) => { flash(copyButton, 'Copy details', ok) })
}

state.onChange(render)
window.addEventListener('popstate', () => {
  current = tabFor(location.pathname)
  if (current === 'gpu' && state.gpu === null) void state.loadGpu()
  render()
})

document.getElementById('app')?.append(
  h('main', { className: 'page' },
    h('header', { className: 'head' },
      h('div', { className: 'mark', role: 'img', ariaLabel: 'Orivon' }),
      h('div', { className: 'head-text' },
        h('h1', { textContent: 'Orivon' }),
        version,
        copyButton)),
    h('nav', { className: 'tabs', role: 'tablist', ariaLabel: 'About' }, ...tabs),
    body))

if (current === 'gpu') void state.loadGpu()
render()
void state.loadVersion()
