// The usage statistics control: the choice as two buttons with neither
// preselected (ADR-0004), the literal JSON of what would be sent, and the list
// of what has been. The JSON is set as text, exactly as main gave it.
import { h } from '../shared/dom.js'
import type { SettingsState } from './state.js'

const STATES: Readonly<Record<string, string>> = {
  undecided: 'You have not chosen. Nothing is sent until you do.',
  accepted: 'On: this is sent about once a month.',
  declined: 'Off: nothing is sent.'
}

export function renderUsage (state: SettingsState): HTMLElement {
  const status = state.usage.status
  if (status === null) {
    void state.usage.load()
    return h('p', { className: 'muted', textContent: 'Loading…' })
  }
  if (status.private) return h('p', { className: 'muted', textContent: 'A private window measures and sends nothing.' })
  const consent = status.consent ?? 'undecided'
  const buttons = (status.options ?? []).map((option) => h('button', {
    className: option.resultingState === consent ? 'btn primary' : 'btn',
    type: 'button',
    textContent: option.label,
    onclick: () => { void state.usage.decide(option.id) }
  }))
  const sent = status.sent ?? []
  return h('div', { className: 'usage' },
    h('p', { className: 'muted', textContent: STATES[consent] ?? '' }),
    h('div', { className: 'usage-buttons' }, ...buttons),
    h('details', null,
      h('summary', { textContent: 'The exact text that would be sent' }),
      h('pre', { className: 'json', textContent: JSON.stringify(status.payload, null, 2) })),
    h('details', null,
      h('summary', { textContent: sent.length === 0 ? 'Nothing has been sent yet' : `What has been sent (${String(sent.length)})` }),
      ...sent.slice().reverse().map((entry) => h('div', { className: 'usage-sent' },
        h('p', { className: 'muted', textContent: new Date(entry.sentAtMs).toLocaleString() }),
        h('pre', { className: 'json', textContent: JSON.stringify(entry.payload, null, 2) })))))
}
