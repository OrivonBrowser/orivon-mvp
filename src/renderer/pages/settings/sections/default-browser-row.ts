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
    case 'can-set': {
      const button = h('button', {
        className: 'btn',
        type: 'button',
        textContent: part.busy ? 'Making default…' : 'Make default',
        disabled: part.busy,
        onclick: () => { void part.makeDefault() }
      })
      if (!part.declined) return button
      const linux = state.about?.platform === 'linux'
      return h('div', { className: 'default-browser-declined' },
        button,
        h('p', { className: 'problem', role: 'alert' },
          'Your system did not accept the change. Set the default browser in your system settings.',
          linux ? h('code', { textContent: LINUX_COMMAND }) : null))
    }
  }
}

/** A newer release exists: say which, and offer its page. Nothing is downloaded or installed. */
export function renderRelease (state: SettingsState): HTMLElement {
  const version = state.updates.available()
  return h('div', { className: 'banner info', role: 'status' },
    h('span', { textContent: `Orivon ${version ?? ''} is available.` }),
    h('button', { className: 'btn small', type: 'button', textContent: 'Open release page', onclick: () => { void state.updates.openRelease() } }))
}
