// The usage statistics control: a switch bound to the choice for the whole computer, the literal JSON of
// the two reports that would be sent, the list of what has been, the install ID once on, Delete my
// data, and the privacy notice. Neither answer is preselected: undecided reads as off and says so. The
// JSON is set as text, exactly as main gave it.
import { h } from '../shared/dom.js'
import { noticeBlocks, type NoticeBlock } from './notice-blocks.js'
import { NOTICE_TEXT } from './notice-source.js'
import type { SettingsState } from './state.js'
import type { UsageStatus } from './usage-state.js'

const OFF_REASONS: Readonly<Record<string, string>> = {
  development: 'Telemetry is off in development builds. Nothing is counted or sent.',
  env: 'Telemetry is turned off for this launch. Nothing is counted or sent.',
  private: 'A private window measures and sends nothing.'
}

const STATES: Readonly<Record<string, string>> = {
  undecided: 'Not chosen yet. Nothing is sent.',
  accepted: 'On. A running total for the month is sent about once a day.',
  declined: 'Off. Nothing is sent.'
}

const ERASE_TEXT: Readonly<Record<string, string>> = {
  working: 'Asking the server to delete your data…',
  done: 'Done. The server was asked to delete everything sent from this computer, and telemetry is off.',
  failed: 'The request did not reach the server. Telemetry is off; try Delete my data again when you are online.',
  nothing: 'Nothing has been sent from this computer.'
}

function drawNotice (blocks: readonly NoticeBlock[]): HTMLElement {
  return h('div', { className: 'usage-notice' }, ...blocks.map((block) => {
    switch (block.kind) {
      case 'heading': return h(block.level === 1 ? 'h3' : 'h4', { textContent: block.text })
      case 'paragraph': return h('p', { textContent: block.text })
      case 'list': return h('ul', null, ...block.items.map((item) => h('li', { textContent: item })))
      case 'table': return h('table', { className: 'usage-table' },
        h('thead', null, h('tr', null, ...block.header.map((cell) => h('th', { textContent: cell })))),
        h('tbody', null, ...block.rows.map((row) => h('tr', null, ...row.map((cell) => h('td', { textContent: cell }))))))
    }
  }))
}

function sentList (status: UsageStatus): HTMLElement {
  const sent = status.sent ?? []
  return h('details', null,
    h('summary', { textContent: sent.length === 0 ? 'Nothing has been sent yet' : `What has been sent (${String(sent.length)})` }),
    ...sent.slice().reverse().map((entry) => h('div', { className: 'usage-sent' },
      h('p', { className: 'muted', textContent: new Date(entry.sentAtMs).toLocaleString() }),
      h('pre', { className: 'json', textContent: JSON.stringify(entry.payload, null, 2) }))))
}

export function renderUsage (state: SettingsState): HTMLElement {
  const status = state.usage.status
  if (status === null) {
    void state.usage.load()
    return h('p', { className: 'muted', textContent: 'Loading…' })
  }
  if (status.private) return h('p', { className: 'muted', textContent: OFF_REASONS['private'] ?? '' })
  const off = status.off
  const consent = status.consent ?? 'undecided'
  const input = h('input', {
    type: 'checkbox',
    id: 'usage-switch',
    checked: off === undefined && consent === 'accepted',
    disabled: off !== undefined
  })
  input.setAttribute('aria-label', 'Share usage statistics')
  input.addEventListener('change', () => {
    // A click leaves the switch focused, and a focused input that is not settled holds every redraw (main.ts).
    input.dataset['settled'] = 'true'
    void state.usage.setOn(input.checked)
  })
  const erase = state.usage.erase
  const eraseButton = h('button', {
    className: 'btn',
    type: 'button',
    id: 'usage-delete',
    textContent: 'Delete my data',
    disabled: erase === 'working',
    onclick: () => { void state.usage.deleteMyData() }
  })
  const noticeButton = h('button', {
    className: 'btn',
    type: 'button',
    id: 'usage-notice-toggle',
    textContent: state.usage.noticeOpen ? 'Hide privacy notice' : 'Privacy notice',
    onclick: () => { state.usage.toggleNotice() }
  })
  return h('div', { className: 'usage' },
    h('div', { className: 'usage-switch' },
      h('span', { className: 'switch' }, input, h('span', { className: 'track' })),
      h('span', { className: 'muted', id: 'usage-state', textContent: off === undefined ? STATES[consent] ?? '' : OFF_REASONS[off] ?? '' })),
    off !== undefined ? null : h('div', { className: 'usage-body' },
      status.installId === null || status.installId === undefined ? null : h('p', { className: 'muted' }, 'Your install ID: ', h('code', { id: 'usage-install-id', textContent: status.installId })),
      h('details', null,
        h('summary', { textContent: 'What is sent' }),
        h('p', { className: 'muted', textContent: 'The usage report, the exact text. Your region comes from your time zone.' }),
        h('pre', { className: 'json', id: 'usage-json', textContent: JSON.stringify(status.usage, null, 2) }),
        h('p', { className: 'muted', textContent: 'The sites report, a separate message that nothing links to the usage report.' }),
        h('pre', { className: 'json', id: 'sites-json', textContent: JSON.stringify(status.sites, null, 2) })),
      sentList(status)),
    h('div', { className: 'usage-buttons' }, off !== undefined || status.everAccepted !== true ? null : eraseButton, noticeButton),
    off === undefined && status.everAccepted !== true && erase === null ? h('p', { className: 'muted', id: 'usage-nothing-sent', textContent: ERASE_TEXT['nothing'] ?? '' }) : null,
    erase === null ? null : h('p', { className: 'muted', id: 'usage-erase', role: 'status', textContent: ERASE_TEXT[erase] ?? '' }),
    state.usage.noticeOpen ? drawNotice(noticeBlocks(NOTICE_TEXT)) : null)
}
