// The "Default browser" row's control and the "new release" banner: custom controls, because each is a line of text with
// a button or an icon beside it rather than a setting.
import { checkIcon } from '../../shared/icons.js'
import { h } from '../../shared/dom.js'
import type { OsPart, UnavailableWhy } from '../os-part.js'
import type { SettingsState } from '../state.js'

/** What sets Orivon as the default web link handler on Linux when the button's own attempt is declined. */
export const linuxCommand = (entry = 'orivon.desktop'): string => `xdg-mime default ${entry} x-scheme-handler/http x-scheme-handler/https`

/** Why a registration is not offered, in words about the person's situation rather than the program's. */
const UNAVAILABLE_WORDS: Readonly<Record<UnavailableWhy, string>> = {
  source: 'Not available while Orivon runs from its source folder. Install Orivon to set it.',
  appimage: 'Not available from an AppImage, which can move. Install the .deb package to set it.',
  platform: 'Not available on this system.',
  private: 'Not available in a private window.'
}

/** On Linux a run from source can be the default once its own entry is installed. */
const LINUX_SOURCE_WORDS = 'Not available until Orivon (source) is in your app list: run node scripts/launch-from-source.mjs install, or install Orivon.'

export function unavailableWords (reason: UnavailableWhy | undefined, platform: string | undefined): string {
  if (reason === undefined) return 'Not available here.'
  return reason === 'source' && platform === 'linux' ? LINUX_SOURCE_WORDS : UNAVAILABLE_WORDS[reason]
}

export function renderDefaultBrowser (state: SettingsState): HTMLElement {
  const part = state.part<OsPart>('os')
  switch (part.view) {
    case 'loading': return h('span', { className: 'muted', textContent: 'Checking…' })
    case 'default':
      return h('span', { className: 'default-browser is-default' }, checkIcon(), h('span', { textContent: 'Orivon is your default browser.' }))
    case 'unavailable':
      return h('span', { className: 'muted', textContent: unavailableWords(part.reason, state.about?.platform) })
    case 'can-set': {
      const windows = state.about?.platform === 'win32'
      const button = h('button', {
        className: 'btn',
        type: 'button',
        textContent: part.busy ? 'Making default…' : windows ? 'Open Windows Settings' : 'Make default',
        disabled: part.busy,
        onclick: () => { void part.makeDefault() }
      })
      // Windows' Settings stay open while the person chooses, so its words hold after a return; a system prompt does not.
      const handoff = part.handedOff && (windows || !part.returnedUndecided)
      return handoff
        ? h('span', { className: 'default-browser-handoff' }, h('span', { className: 'muted', textContent: windows ? 'Choose Orivon for web links in Windows Settings. The button opens them again.' : 'Confirm in the system\'s prompt to make Orivon the default.' }), button)
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
  const command = linuxCommand(part.entry)
  const copy = h('button', { className: 'btn small', type: 'button', textContent: 'Copy' })
  let reset: ReturnType<typeof setTimeout> | undefined
  copy.addEventListener('click', () => {
    void navigator.clipboard.writeText(command).then(() => 'Copied', () => 'Could not copy').then((text) => {
      copy.textContent = text
      if (reset !== undefined) clearTimeout(reset)
      reset = setTimeout(() => { copy.textContent = 'Copy' }, COPIED_MS)
    })
  })
  return h('div', { className: 'default-browser-problem' },
    problem,
    h('p', { className: 'row-help' }, 'To set it yourself, run this in a terminal:'),
    h('div', { className: 'command-line' }, h('code', { textContent: command }), copy))
}

/** A newer release exists: say which, and offer its page. Nothing is downloaded or installed. */
export function renderRelease (state: SettingsState): HTMLElement {
  const version = state.updates.available()
  return h('div', { className: 'banner info', role: 'status' },
    h('span', { textContent: `Orivon ${version ?? ''} is available.` }),
    h('button', { className: 'btn small', type: 'button', textContent: 'Open release page', onclick: () => { void state.updates.openRelease() } }))
}
