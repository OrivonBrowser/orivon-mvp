// The Import page's document. It is built again from the state on every change; the key that was focused is
// found again afterwards, so a tick or an arrow key never drops the focus.
import { h, replaceChildren } from '../shared/dom.js'
import { downloadIcon, fileIcon, privateIcon } from '../shared/icons.js'
import { details, errorText, headline, progressText } from './copy.js'
import type { ImportState, SourceRow } from './state.js'

/** The colour of a browser's letter mark, from the set `controls.css` names. */
const MARK_COLOR: Readonly<Record<SourceRow['key'], string>> = { chrome: 'blue', chromium: 'gray', edge: 'teal', brave: 'orange', firefox: 'red' }

/** A detection that takes longer than this shows placeholder rows instead of a blank card. */
const SKELETON_DELAY_MS = 150

export class ImportView {
  private readonly body = h('div', { className: 'body' })
  private readonly header = h('header', { className: 'head' },
    h('h1', null, downloadIcon(), 'Import bookmarks and history'),
    h('p', { className: 'intro', textContent: 'Orivon reads your bookmarks and history from another browser once and changes nothing there.' }))
  private skeleton = false

  constructor (private readonly state: ImportState) {
    state.onChange(() => { this.render() })
    // Placeholders only for a detection that takes a moment: a fast answer never flashes them.
    setTimeout(() => {
      if (state.step !== 'detecting') return
      this.skeleton = true
      this.render()
    }, SKELETON_DELAY_MS)
  }

  mount (root: HTMLElement): void {
    root.append(h('main', { className: 'page' }, this.header, this.body))
    this.render()
  }

  private render (): void {
    const focused = (document.activeElement as HTMLElement | null)?.dataset['focus']
    const { step } = this.state
    // A private window has nothing to import into: the message is the whole page.
    this.header.hidden = step === 'private'
    if (step === 'private') replaceChildren(this.body, this.privateNotice())
    else if (step === 'detecting') replaceChildren(this.body, this.detecting())
    else if (step === 'done') replaceChildren(this.body, this.done())
    else if (step === 'error') replaceChildren(this.body, this.failed())
    else replaceChildren(this.body, this.choice())
    const target = step === 'done' || step === 'error'
      ? this.body.querySelector<HTMLElement>('[role="status"], [role="alert"]')
      : focused === undefined ? null : this.body.querySelector<HTMLElement>(`[data-focus="${focused}"]`)
    // A result takes the focus so a screen reader reads it; a choice keeps it where the person was.
    target?.focus({ preventScroll: true })
  }

  private privateNotice (): HTMLElement {
    return h('div', { className: 'empty-state', role: 'status' }, privateIcon(), h('p', { textContent: errorText('private', null) }))
  }

  private detecting (): HTMLElement {
    const rows = !this.skeleton ? [] : [0, 1, 2].map(() => h('div', { className: 'source-row skeleton-row' },
      h('span', { className: 'skeleton source-skeleton-mark' }),
      h('div', { className: 'source-skeleton-text' }, h('span', { className: 'skeleton source-skeleton-name' }), h('span', { className: 'skeleton source-skeleton-line' }))))
    const card = h('section', { className: 'card', ariaBusy: 'true' }, h('h2', { textContent: 'Choose where to import from' }), h('div', { className: 'skeleton-list' }, ...rows))
    card.setAttribute('aria-label', 'Looking for other browsers')
    return card
  }

  private choice (): HTMLElement {
    const { state } = this
    const running = state.step === 'running'
    const parts: Array<HTMLElement | null> = []
    if (state.sources.length === 0) {
      parts.push(h('div', { className: 'banner info', role: 'status', textContent: 'No other browser was found on this computer. You can still import a bookmarks file.' }))
    }
    parts.push(this.sourceCard(running))
    if (!state.isFile) parts.push(this.whatCard(running))
    parts.push(this.footer(running))
    return h('div', { className: 'steps' }, ...parts)
  }

  private sourceCard (running: boolean): HTMLElement {
    const { state } = this
    const rows = state.sources.map((source, index) => this.radioRow(index, running,
      h('span', { className: 'item-icon mark-icon' }, this.letterMark(source)),
      source.browser, source.profile))
    rows.push(this.radioRow(state.sources.length, running, h('span', { className: 'item-icon file-icon' }, fileIcon()), 'Bookmarks HTML file', 'A file exported from any browser'))
    const list = h('ul', { className: 'listbox sources', role: 'radiogroup', ariaLabel: 'Where to import from' }, ...rows)
    list.addEventListener('keydown', (event) => { this.onKey(event) })
    return h('section', { className: 'card' }, h('h2', { textContent: 'Choose where to import from' }), list)
  }

  private radioRow (index: number, running: boolean, icon: HTMLElement, title: string, sub: string): HTMLElement {
    const selected = index === this.state.selected
    const row = h('li', { className: 'listbox-item', role: 'radio', tabIndex: selected && !running ? 0 : -1 },
      icon, h('span', { className: 'item-title', textContent: title }), h('span', { className: 'item-sub', textContent: sub }))
    row.dataset['focus'] = `radio-${String(index)}`
    row.dataset['index'] = String(index)
    row.setAttribute('aria-checked', String(selected))
    if (running) row.setAttribute('aria-disabled', 'true')
    else row.addEventListener('click', () => { this.state.select(index) })
    return row
  }

  private letterMark (source: SourceRow): HTMLElement {
    const mark = h('span', { className: 'mark', textContent: source.browser.slice(0, 1) })
    mark.dataset['color'] = MARK_COLOR[source.key]
    return mark
  }

  private whatCard (running: boolean): HTMLElement {
    const { state } = this
    const box = (what: 'bookmarks' | 'history', label: string, checked: boolean, disabled: boolean, help?: string): HTMLElement => {
      const input = h('input', { type: 'checkbox', checked, disabled: disabled || running })
      input.dataset['focus'] = what
      input.addEventListener('change', () => { state.tick(what, input.checked) })
      return h('div', { className: 'what-row' }, h('label', { className: 'check' }, input, h('span', { textContent: label })), help === undefined ? null : h('p', { className: 'what-help', textContent: help }))
    }
    return h('section', { className: 'card' }, h('h2', { textContent: 'What to import' }),
      box('bookmarks', 'Bookmarks', state.bookmarks, false),
      state.historyOn
        ? box('history', 'Browsing history', state.history, false)
        : box('history', 'Browsing history', false, true, 'History is turned off in Settings.'))
  }

  private footer (running: boolean): HTMLElement {
    const { state } = this
    const button = h('button', { className: 'btn primary', type: 'button', textContent: running ? 'Importing…' : 'Import', disabled: running || !state.canImport })
    button.dataset['focus'] = 'import'
    button.addEventListener('click', () => { void state.start() })
    const progress = running
      ? h('div', { className: 'run-progress', role: 'status' },
        h('div', { className: 'progress indeterminate', ariaHidden: 'true' }, h('div', { className: 'progress-bar' })),
        h('p', { className: 'run-text', textContent: progressText(state.phase) }))
      : null
    return h('div', { className: 'footer' }, progress, h('div', { className: 'btn-row' }, button))
  }

  private done (): HTMLElement {
    const { state } = this
    const result = state.result
    if (result === null) return h('div')
    const banner = h('div', { className: 'banner ok result', role: 'status', tabIndex: -1 },
      h('p', { className: 'result-head', textContent: headline(result, state.from) }),
      ...details(result).map((line) => h('p', { className: 'result-line', textContent: line })))
    const actions = h('div', { className: 'btn-row start' },
      state.manager && result.bookmarks > 0 ? h('button', { className: 'btn', type: 'button', textContent: 'Open bookmark manager', onclick: () => { void state.openManager() } }) : null,
      h('button', { className: 'btn', type: 'button', textContent: 'Import from another browser', onclick: () => { state.again() } }))
    return h('div', { className: 'steps' }, banner, actions)
  }

  private failed (): HTMLElement {
    const { state } = this
    const reason = state.error ?? 'unreadable'
    const partial = state.result !== null && (state.result.bookmarks > 0 || state.result.pages > 0) ? headline(state.result, state.from) : null
    const banner = h('div', { className: 'banner error result', role: 'alert', tabIndex: -1 },
      h('p', { className: 'result-head', textContent: errorText(reason, state.from) }),
      partial === null ? null : h('p', { className: 'result-line', textContent: partial }))
    const retry = h('button', { className: 'btn', type: 'button', textContent: 'Try again', onclick: () => { state.again() } })
    return h('div', { className: 'steps' }, banner, h('div', { className: 'btn-row start' }, retry))
  }

  /** Up and Down move the choice like a radio group; Enter starts. */
  private onKey (event: KeyboardEvent): void {
    const { state } = this
    if (state.step !== 'choosing' || event.altKey || event.ctrlKey || event.metaKey) return
    const last = state.sources.length
    const moves: Record<string, number> = { ArrowDown: state.selected + 1, ArrowRight: state.selected + 1, ArrowUp: state.selected - 1, ArrowLeft: state.selected - 1, Home: 0, End: last }
    const next = moves[event.key]
    if (next !== undefined) {
      event.preventDefault()
      state.select(Math.min(Math.max(next, 0), last))
      this.body.querySelector<HTMLElement>(`[data-focus="radio-${String(state.selected)}"]`)?.focus()
    } else if (event.key === 'Enter' && state.canImport) {
      event.preventDefault()
      void state.start()
    } else if (event.key === ' ') {
      event.preventDefault()
      const index = Number((event.target as HTMLElement).dataset['index'])
      if (Number.isInteger(index)) state.select(index)
    }
  }
}
