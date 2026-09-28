// The "Clear browsing data" block: what to forget, how far back for history,
// and one button that asks twice. An app's own storage is a separate box with
// its consequence written beside it, and is never on unless chosen.
import type { ClearRequest, HistoryRange } from '../../../main/privacy/clear-data.js'
import { h } from '../shared/dom.js'
import type { SettingsState } from './state.js'

const RANGES: ReadonlyArray<readonly [HistoryRange, string]> = [
  ['hour', 'The last hour'],
  ['day', 'The last 24 hours'],
  ['week', 'The last 7 days'],
  ['all', 'All time']
]

const FAILED_WORDS: Readonly<Record<string, string>> = {
  history: 'history',
  siteData: 'cookies and site data',
  cache: 'cached files',
  zoomLevels: 'saved zoom levels',
  appData: 'app data'
}

function option (label: string, help: string | null, checked = false): { input: HTMLInputElement, element: HTMLElement } {
  const input = h('input', { type: 'checkbox', checked })
  const element = h('label', { className: 'clear-option' }, input, h('span', null, h('span', { textContent: label }), help === null ? null : h('span', { className: 'muted block', textContent: help })))
  return { input, element }
}

export function renderClearData (state: SettingsState): HTMLElement {
  const history = option('Browsing history', null, true)
  const range = h('select', { className: 'select' })
  for (const [value, label] of RANGES) range.append(h('option', { value, textContent: label }))
  range.value = 'day'
  range.setAttribute('aria-label', 'How far back to clear history')
  const siteData = option('Cookies and site data', 'Signs you out of websites and removes what they stored in this browser. Always for all time.')
  const cache = option('Cached files', 'Pages and images kept to load sites faster. Always for all time.')
  const zoom = option('Saved zoom levels', null)
  const appData = option('App data', 'What apps that hold permissions keep in the browser, such as a signed-in session or a local database. It cannot be undone. Files an app saved in its own folder are not removed.')
  appData.element.classList.add('danger-option')
  const result = h('p', { className: 'muted', role: 'status' })
  const button = h('button', { className: 'btn danger', type: 'button', textContent: 'Clear data' })

  let disarm: ReturnType<typeof setTimeout> | undefined
  const rearm = (): void => {
    if (disarm !== undefined) clearTimeout(disarm)
    disarm = undefined
    button.textContent = 'Clear data'
    button.classList.remove('armed')
  }
  const request = (): ClearRequest => ({
    history: history.input.checked ? range.value as HistoryRange : 'none',
    siteData: siteData.input.checked,
    cache: cache.input.checked,
    zoomLevels: zoom.input.checked,
    appData: appData.input.checked
  })
  button.addEventListener('click', () => {
    const chosen = request()
    if (chosen.history === 'none' && !chosen.siteData && !chosen.cache && !chosen.zoomLevels && !chosen.appData) {
      result.textContent = 'Choose what to clear.'
      return
    }
    if (disarm === undefined) {
      button.textContent = 'Click again to clear'
      button.classList.add('armed')
      disarm = setTimeout(rearm, 4000)
      return
    }
    rearm()
    void state.privacy.clear(chosen).then((outcome) => {
      if (outcome === null) result.textContent = 'That could not be cleared.'
      else if (outcome.ok) result.textContent = 'Cleared.'
      else result.textContent = `Could not clear ${outcome.failed.map((name) => FAILED_WORDS[name] ?? name).join(', ')}.`
    })
  })

  return h('div', { className: 'clear-data' },
    h('div', { className: 'clear-history' }, history.element, range),
    siteData.element, cache.element, zoom.element, appData.element,
    h('div', { className: 'clear-actions' }, button, result))
}
