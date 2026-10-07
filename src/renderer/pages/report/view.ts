// Draws the report form once and keeps it in step with the state. The form is built a single time, so typing in
// it is never interrupted by a redraw; only the parts that depend on the state are updated when it changes.
import { h, replaceChildren } from '../shared/dom.js'
import { ReportState } from './state.js'
import type { CrashRow, SentRow, TestKind } from './state.js'

const KIND_TEXT: Readonly<Record<string, string>> = {
  'main-error': 'The browser stopped on an error',
  renderer: 'A page crashed',
  'child-process': 'A helper process crashed',
  'unclean-exit': 'Orivon did not shut down correctly'
}

const FLASH_MS = 2000
const ARM_MS = 4000

const TESTS: ReadonlyArray<{ kind: TestKind, label: string, says: string }> = [
  { kind: 'renderer', label: 'Crash a tab', says: 'Opens a blank tab and ends its page process, as a crash would. The tab shows the card with a Report button. Orivon stays open.' },
  { kind: 'main-error', label: 'Throw an error in the main process', says: 'Closes Orivon at once, as an uncaught error does. The next start offers to report it.' },
  { kind: 'main-native', label: 'Crash Orivon natively', says: 'Closes Orivon at once with a native crash, which leaves a crash dump on this computer (nothing is uploaded). The next start offers to report it.' }
]

function when (stamp: string): string {
  const date = new Date(stamp)
  return Number.isNaN(date.getTime()) ? stamp : date.toLocaleString()
}

function crashLabel (row: CrashRow): string {
  return `${KIND_TEXT[row.kind] ?? row.kind}: ${row.process}, ${row.reason}, ${when(row.at)}${row.reported ? ' (already reported)' : ''}`
}

function formatSize (bytes: number): string {
  return bytes < 1024 * 1024 ? `${Math.max(1, Math.round(bytes / 1024))} KB` : `${(bytes / 1048576).toFixed(1)} MB`
}

function flash (button: HTMLButtonElement, then: string, now: string): void {
  button.textContent = now
  setTimeout(() => { button.textContent = then }, FLASH_MS)
}

interface Box {
  readonly row: HTMLElement
  readonly input: HTMLInputElement
  readonly label: HTMLElement
}

function box (id: string, text: string, hint: string | null): Box {
  const input = h('input', { type: 'checkbox', id })
  const label = h('span', { textContent: text })
  const row = h('label', { className: 'check include' }, input, h('span', { className: 'include-text' }, label, hint === null ? null : h('span', { className: 'hint', textContent: hint })))
  return { row, input, label }
}

export function mountReport (root: HTMLElement, state: ReportState): void {
  const crashSelect = h('select', { className: 'select', id: 'report-crash' })
  const what = h('textarea', { className: 'textarea', id: 'report-what', rows: 6, placeholder: 'What were you doing, what did you expect, what happened instead?' })
  const contact = h('input', { className: 'text', id: 'report-contact', type: 'text', placeholder: 'An email address or a handle, if you want an answer' })
  const diagnostics = box('report-diagnostics', 'Technical details', 'Versions, the computer and its graphics, the extensions installed, settings that are switches or choices, and the crashes recorded here. No page addresses and nothing you typed.')
  const log = box('report-log', 'Recent log', 'The last lines Orivon wrote about what it was doing. Your home folder is replaced by ~.')
  const page = box('report-page', 'The crashed page\'s address', 'Which page was open in the tab that crashed.')
  const dump = box('report-dump', 'The crash dump', 'A memory snapshot of the crashed process. It may hold fragments of pages that were open.')
  const includes = h('div', { className: 'includes' }, diagnostics.row, log.row, page.row, dump.row)
  const raw = h('pre', { className: 'raw-body', id: 'report-preview', tabIndex: 0, textContent: '' })
  const rawSize = h('span', { className: 'hint', id: 'report-size' })
  const copyButton = h('button', { className: 'btn', type: 'button', id: 'report-copy', textContent: 'Copy as text' })
  const sendButton = h('button', { className: 'btn primary', type: 'button', id: 'report-send', textContent: 'Send report' })
  const status = h('div', { role: 'status', id: 'report-status' })
  const sentList = h('div', { id: 'report-sent' })
  const privateNote = h('div', { className: 'banner info', id: 'report-private', hidden: true, textContent: 'This is a private session. No page address is kept or offered, and this window\'s reports are forgotten when it closes.' })
  const loadError = h('div', { className: 'banner error', role: 'alert', hidden: true, textContent: 'The report form could not be loaded.' })

  const fieldOf = (label: string, control: HTMLElement, hint?: string): HTMLElement => h('label', { className: 'field' }, h('span', { textContent: label }), control, hint === undefined ? null : h('span', { className: 'hint', textContent: hint }))

  crashSelect.addEventListener('change', () => { state.set({ crashId: crashSelect.value === '' ? null : crashSelect.value }) })
  what.addEventListener('input', () => { state.set({ description: what.value }) })
  contact.addEventListener('input', () => { state.set({ contact: contact.value }) })
  diagnostics.input.addEventListener('change', () => { state.set({ diagnostics: diagnostics.input.checked }) })
  log.input.addEventListener('change', () => { state.set({ log: log.input.checked }) })
  page.input.addEventListener('change', () => { state.set({ page: page.input.checked }) })
  dump.input.addEventListener('change', () => { state.set({ dump: dump.input.checked }) })
  sendButton.onclick = () => { void state.send() }
  copyButton.onclick = () => { void state.copy().then((ok) => { flash(copyButton, 'Copy as text', ok ? 'Copied' : 'Could not copy') }) }

  const notice = h('button', { className: 'link-btn', type: 'button', id: 'report-notice', textContent: 'Privacy notice: Bug reports', onclick: () => { void state.openNotice() } })
  const disclosure = h('p', { className: 'fine', id: 'report-disclosure' },
    'Sent to telemetry.orivonstack.com and kept for 90 days. To find the cause, the maintainers may give it to an AI coding assistant (today Claude, by Anthropic, in the USA); pressing Send agrees to that. ',
    notice)

  const tests = h('details', { className: 'raw tests', id: 'report-tests' },
    h('summary', { textContent: 'Test the crash reporter' }),
    h('div', { className: 'tests-body' },
      ...TESTS.map((test) => h('div', { className: 'test' },
        h('button', { className: 'btn', type: 'button', id: `report-test-${test.kind}`, textContent: test.label, onclick: () => { void state.runTest(test.kind) } }),
        h('span', { className: 'hint', textContent: test.says })))))

  root.append(h('main', { className: 'page' },
    h('header', { className: 'head' },
      h('div', { className: 'mark', role: 'img', ariaLabel: 'Orivon' }),
      h('div', { className: 'head-text' },
        h('h1', { textContent: 'Report a problem' }),
        h('p', { className: 'sub', textContent: 'Nothing leaves this computer until you press Send. The report below is exactly what would be sent.' }))),
    privateNote,
    loadError,
    h('div', { className: 'card form' },
      fieldOf('Which problem is this about?', crashSelect),
      fieldOf('What happened?', what),
      fieldOf('How can we reach you? (optional)', contact),
      h('div', { className: 'field' }, h('span', { textContent: 'What to include' }), includes)),
    h('details', { className: 'raw', id: 'report-whole' },
      h('summary', { textContent: 'Show the whole report' }),
      h('div', { className: 'raw-head' }, rawSize),
      raw),
    h('div', { className: 'actions' }, copyButton, sendButton),
    disclosure,
    status,
    h('h2', { className: 'group-label', textContent: 'Sent reports' }),
    sentList,
    tests))

  /** A Delete button that asks twice: the first click arms it, the second deletes. */
  function deleteButton (row: SentRow, showError: (text: string) => void): HTMLButtonElement {
    let armedTimer: ReturnType<typeof setTimeout> | undefined
    const button = h('button', { className: 'btn danger small', type: 'button', textContent: 'Delete from server' })
    const disarm = (): void => { armedTimer = undefined; button.classList.remove('armed'); button.textContent = 'Delete from server' }
    button.onclick = () => {
      showError('')
      if (armedTimer === undefined) {
        button.classList.add('armed')
        button.textContent = 'Click again to delete'
        armedTimer = setTimeout(disarm, ARM_MS)
        return
      }
      clearTimeout(armedTimer)
      button.disabled = true
      void state.erase(row.reportId).then((problem) => {
        if (problem === null) return
        button.disabled = false
        disarm()
        showError(problem)
      })
    }
    return button
  }

  function drawSent (rows: readonly SentRow[]): void {
    if (rows.length === 0) {
      replaceChildren(sentList, h('p', { className: 'muted', id: 'report-sent-empty', textContent: 'You have not sent a report from this computer.' }))
      return
    }
    const error = h('p', { className: 'banner error', role: 'alert', hidden: true })
    const showError = (text: string): void => { error.textContent = text; error.hidden = text === '' }
    const items = rows.map((row) => {
      const item = h('div', { className: 'row sent-row' },
        h('div', { className: 'sent-text' },
          h('span', { className: 'sent-summary', textContent: row.summary === '' ? '(no description)' : row.summary }),
          h('span', { className: 'hint' }, `${when(row.at)} · `, h('code', { textContent: row.reportId }))),
        deleteButton(row, showError))
      item.dataset['reportId'] = row.reportId
      return item
    })
    replaceChildren(sentList, h('div', { className: 'card' }, ...items), error)
  }

  let drawnSent = ''
  let shownOutcome: unknown = null
  let drawnCrashes = ''

  function render (): void {
    const { info, choices, preview, outcome } = state
    loadError.hidden = !state.failed
    privateNote.hidden = info?.private !== true
    const crashesKey = JSON.stringify(info?.crashes ?? [])
    if (crashesKey !== drawnCrashes) {
      drawnCrashes = crashesKey
      replaceChildren(crashSelect, h('option', { value: '', textContent: 'Nothing in particular' }), ...(info?.crashes ?? []).map((row) => h('option', { value: row.id, textContent: crashLabel(row) })))
    }
    crashSelect.value = choices.crashId ?? ''
    if (what.value !== choices.description) what.value = choices.description
    if (info !== null) { what.maxLength = info.limits.description; contact.maxLength = info.limits.contact }
    diagnostics.input.checked = choices.diagnostics
    log.input.checked = choices.log
    const crash = state.crash
    page.row.hidden = crash === undefined || !crash.hasPage
    page.input.checked = choices.page
    dump.row.hidden = crash === undefined || crash.dumpBytes === null
    dump.input.checked = choices.dump
    dump.label.textContent = crash?.dumpBytes == null ? 'The crash dump' : `The crash dump (${formatSize(crash.dumpBytes)})`
    raw.textContent = preview?.text ?? ''
    rawSize.textContent = preview === null ? '' : `${formatSize(preview.bytes)} as sent`
    sendButton.disabled = !state.canSend
    sendButton.textContent = state.sending ? 'Sending…' : 'Send report'
    copyButton.disabled = preview?.sendable !== true
    sendButton.title = preview?.sendable === false ? 'Say what happened first' : ''
    if (outcome === null) {
      replaceChildren(status)
    } else if (outcome.kind === 'sent') {
      const idButton = h('button', { className: 'link-btn', type: 'button', id: 'report-copy-id', textContent: 'Copy ID' })
      idButton.onclick = () => { void state.copyId(outcome.reportId).then((ok) => { flash(idButton, 'Copy ID', ok ? 'Copied' : 'Could not copy') }) }
      replaceChildren(status, h('div', { className: 'banner ok', id: 'report-sent-banner' }, 'Sent. Report ID ', h('code', { id: 'report-id', textContent: outcome.reportId }), ' ', idButton))
    } else {
      replaceChildren(status, h('div', { className: 'banner error', role: 'alert', id: 'report-failed', textContent: outcome.text }))
    }
    // The answer sits below the buttons, which may be off the screen: bring it into view once.
    if (outcome !== shownOutcome) { shownOutcome = outcome; if (outcome !== null) status.scrollIntoView({ block: 'nearest' }) }
    const sentKey = JSON.stringify(info?.sent ?? [])
    if (sentKey !== drawnSent && info !== null) { drawnSent = sentKey; drawSent(info.sent) }
  }

  state.onChange(render)
  render()
}
