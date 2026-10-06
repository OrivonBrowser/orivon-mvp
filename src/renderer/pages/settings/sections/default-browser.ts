import type { Section } from '../model.js'
import type { SettingsState } from '../state.js'
import { renderDefaultBrowser, renderDefaultBrowserProblem } from './default-browser-row.js'

/** Which browser the computer opens a clicked link in. A private session changes nothing outside itself, so it has no section. */
export function defaultBrowserSection (state: SettingsState): Section {
  return {
    id: 'default-browser',
    title: 'Default browser',
    intro: 'The browser the computer opens when you click a link in another program.',
    rows: state.profiles?.isPrivate === true
      ? []
      : [{
          id: 'default-browser',
          label: 'Default browser',
          help: 'Links you click in other programs open in Orivon.',
          keywords: ['default', 'browser', 'links', 'open links', 'http', 'https', 'web', 'system', 'make default', 'set default'],
          below: renderDefaultBrowserProblem,
          control: { type: 'custom', render: renderDefaultBrowser }
        }]
  }
}
