// The "Default browser" row's control and the "new release" banner: custom controls, because each is a line of text with
// a button or an icon beside it rather than a setting.
import { checkIcon } from '../../shared/icons.js'
import { h } from '../../shared/dom.js'
import type { OsPart, UnavailableWhy } from '../os-part.js'
import type { SettingsState } from '../state.js'

/** What sets Orivon as the default web link handler on Linux when the button's own attempt is declined. */
export const LINUX_COMMAND = 'xdg-mime default orivon.desktop x-scheme-handler/http x-scheme-handler/https'

/** Why a registration is not offered, in words about the person's situation rather than the program's. */
const UNAVAILABLE_WORDS: Readonly<Record<UnavailableWhy, string>> = {
  source: 'Not available while Orivon runs from its source folder. Install Orivon to set it.',
  appimage: 'Not available from an AppImage, which can move. Install the .deb package to set it.',
  platform: 'Not available on this system.',
  private: 'Not available in a private window.'
}

export function renderDefaultBrowser (state: SettingsState): HTMLElement {
  const part = state.part<OsPart>('os')
  switch (part.view) {
    case 'loading': return h('span', { className: 'muted', textContent: 'Checking…' })
    case 'default':
      return h('span', { className: 'default-browser is-default' }, checkIcon(), h('span', { textContent: 'Orivon is your default browser.' }))
    case 'unavailable':
      return h('span', { className: 'muted', textContent: part.reason === undefined ? 'Not available here.' : UNAVAILABLE_WORDS[part.reason] })
    case 'can-set': {
      const windows = state.about?.platform === 'win32'
      const button = h('button', {
        className: 'btn',
        type: 'button',
        textContent: part.busy ? 'Making default…' : windows ? 'Open Windows Settings' : 'Make default',
        disabled: part.busy,
        onclick: () => { void part.makeDefault() }
      })
      return part.handedOff
        ? h('span', { className: 'default-browser-handoff' }, h('span', { className: 'muted', textContent: 'Finish in Windows Settings: choose Orivon for web links.' }), button)
        : button
    }
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
