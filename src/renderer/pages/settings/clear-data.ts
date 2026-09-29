// The "Clear browsing data" block: what to forget, how far back for history,
// and one button that asks twice. An app's own storage is a separate box with
// its consequence written beside it, and is never on unless chosen.
//
// The checkboxes and the range read from, and write to, `selection` below --
// a module-level object outside `renderClearData`, the same idiom
// ../profiles/main.ts's `newName`/`newColor` already use -- rather than a
// plain local variable, because a push (privacy.changed; clearing history is
// itself one, landing back on this same tab) can redraw the whole section at
// any time. A local variable would reset to the defaults on every redraw,
// silently discarding whatever the person had chosen a moment before.
import type { ClearRequest, HistoryRange } from '../../../main/privacy/clear-data.js'
import { h } from '../shared/dom.js'
import { armEnded } from '../shared/armed.js'
import type { SettingsState } from './state.js'
import type { ClearOutcome } from './privacy-state.js'

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

interface Selection {
  historyChecked: boolean
  range: HistoryRange
  siteData: boolean
  cache: boolean
  zoomLevels: boolean
  appData: boolean
}

const selection: Selection = { historyChecked: true, range: 'day', siteData: false, cache: false, zoomLevels: false, appData: false }

function clearWords (outcome: ClearOutcome | null): string {
  if (outcome === null) return ''
  switch (outcome.kind) {
    case 'nothing-chosen': return 'Choose what to clear.'
    case 'refused': return 'That could not be cleared.'
    case 'ok': return 'Cleared.'
    case 'failed': return `Could not clear ${outcome.names.map((name) => FAILED_WORDS[name] ?? name).join(', ')}.`
  }
}

function option (label: string, help: string | null, checked: boolean, onToggle: (checked: boolean) => void): HTMLElement {
  const input = h('input', { type: 'checkbox', checked })
  input.addEventListener('change', () => { onToggle(input.checked) })
  return h('label', { className: 'clear-option' }, input, h('span', null, h('span', { textContent: label }), help === null ? null : h('span', { className: 'muted block', textContent: help })))
}

export function renderClearData (state: SettingsState): HTMLElement {
  const history = option('Browsing history', null, selection.historyChecked, (checked) => { selection.historyChecked = checked })
  const range = h('select', { className: 'select' })
  for (const [value, label] of RANGES) range.append(h('option', { value, textContent: label }))
  range.value = selection.range
  range.addEventListener('change', () => { selection.range = range.value as HistoryRange })
  range.setAttribute('aria-label', 'How far back to clear history')
  const siteData = option('Cookies and site data', 'Signs you out of websites and removes what they stored in this browser. Always for all time.', selection.siteData, (checked) => { selection.siteData = checked })
  const cache = option('Cached files', 'Pages and images kept to load sites faster. Always for all time.', selection.cache, (checked) => { selection.cache = checked })
  const zoom = option('Saved zoom levels', null, selection.zoomLevels, (checked) => { selection.zoomLevels = checked })
  const appData = option('App data', 'What apps that hold permissions keep in the browser, such as a signed-in session or a local database. It cannot be undone. Files an app saved in its own folder are not removed.', selection.appData, (checked) => { selection.appData = checked })
  appData.classList.add('danger-option')
  const result = h('p', { className: 'muted', role: 'status', textContent: clearWords(state.privacy.lastClear) })
  const button = h('button', { className: 'btn danger', type: 'button', textContent: 'Clear data' })

  let disarm: ReturnType<typeof setTimeout> | undefined
  const rearm = (): void => {
    if (disarm !== undefined) clearTimeout(disarm)
    disarm = undefined
    button.textContent = 'Clear data'
    button.classList.remove('armed')
    // A redraw held back while this button was armed (settings/main.ts's own
    // render gate) is not lost: this ends whether the confirm window timed
    // out or the second click just ran, either way telling it to check again.
    armEnded()
  }
  const request = (): ClearRequest => ({
    history: selection.historyChecked ? selection.range : 'none',
    siteData: selection.siteData,
    cache: selection.cache,
    zoomLevels: selection.zoomLevels,
    appData: selection.appData
  })
  button.addEventListener('click', () => {
    const chosen = request()
    if (chosen.history === 'none' && !chosen.siteData && !chosen.cache && !chosen.zoomLevels && !chosen.appData) {
      state.privacy.nothingChosen()
      return
    }
    if (disarm === undefined) {
      button.textContent = 'Click again to clear'
      button.classList.add('armed')
      disarm = setTimeout(rearm, 4000)
      return
    }
    rearm()
    void state.privacy.clear(chosen)
  })

  return h('div', { className: 'clear-data' },
    h('div', { className: 'clear-history' }, history, range),
    siteData, cache, zoom, appData,
    h('div', { className: 'clear-actions' }, button, result))
}
