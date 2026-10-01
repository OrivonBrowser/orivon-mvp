// The "Default browser" row's control and the "new release" banner: custom controls, because each is a line of text with
// a button or an icon beside it rather than a setting.
import { checkIcon } from '../../shared/icons.js'
import { h } from '../../shared/dom.js'
import type { OsPart } from '../os-part.js'
import type { SettingsState } from '../state.js'

/** What sets Orivon as the default on Linux when the button's own attempt is declined. */
export const LINUX_COMMAND = 'xdg-settings set default-web-browser orivon.desktop'

export function renderDefaultBrowser (state: SettingsState): HTMLElement {
  const part = state.part<OsPart>('os')
  switch (part.view) {
    case 'loading': return h('span', { className: 'muted', textContent: 'Checking…' })
    case 'default':
      return h('span', { className: 'default-browser is-default' }, checkIcon(), h('span', { textContent: 'Orivon is your default browser.' }))
    case 'unavailable':
      return h('span', { className: 'muted', textContent: 'Available when Orivon is installed from the .deb package.' })
    case 'can-set':
      return h('button', {
        className: 'btn',
        type: 'button',
        textContent: part.busy ? 'Making default…' : 'Make default',
        disabled: part.busy,
        onclick: () => { void part.makeDefault() }
      })
  }
}

const COPIED_MS = 2000

/** Under the row's help once the system declined: what happened, and on Linux the command that does it by hand. */
export function renderDefaultBrowserProblem (state: SettingsState): HTMLElement | null {
  const part = state.part<OsPart>('os')
  if (part.view !== 'can-set' || !part.declined) return null
  const problem = h('p', { className: 'problem', role: 'alert' }, 'Your system did not accept the change.')
  if (state.about?.platform !== 'linux') return problem
  const copy = h('button', { className: 'btn small', type: 'button', textContent: 'Copy' })
  let reset: ReturnType<typeof setTimeout> | undefined
  copy.addEventListener('click', () => {
    void navigator.clipboard.writeText(LINUX_COMMAND).then(() => 'Copied', () => 'Could not copy').then((text) => {
      copy.textContent = text
      if (reset !== undefined) clearTimeout(reset)
      reset = setTimeout(() => { copy.textContent = 'Copy' }, COPIED_MS)
    })
  })
  return h('div', { className: 'default-browser-problem' },
    problem,
    h('p', { className: 'row-help' }, 'To set it yourself, run this in a terminal:'),
    h('div', { className: 'command-line' }, h('code', { textContent: LINUX_COMMAND }), copy))
}

/** A newer release exists: say which, and offer its page. Nothing is downloaded or installed. */
export function renderRelease (state: SettingsState): HTMLElement {
  const version = state.updates.available()
  return h('div', { className: 'banner info', role: 'status' },
    h('span', { textContent: `Orivon ${version ?? ''} is available.` }),
    h('button', { className: 'btn small', type: 'button', textContent: 'Open release page', onclick: () => { void state.updates.openRelease() } }))
}
