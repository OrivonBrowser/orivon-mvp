// The notices the list can give instead of rows: why history is not being kept, and what an empty list means.
import type { HistoryStatus } from '../../../main/history/history-service.js'
import { h, replaceChildren } from '../shared/dom.js'
import { clockIcon } from '../shared/icons.js'

/** Shows or hides `banner` for `status`; `openSettings` is what its button leads to. */
export function renderBanner (banner: HTMLElement, status: HistoryStatus | null, openSettings: () => void): void {
  banner.hidden = true
  if (status === null) return
  if (status.problem !== null) {
    banner.hidden = false
    replaceChildren(banner, h('strong', { textContent: 'History is not being kept. ' }), 'The history file could not be opened. ',
      h('button', { className: 'link-btn', type: 'button', textContent: 'Details', onclick: openSettings }))
  } else if (!status.remembering) {
    banner.hidden = false
    replaceChildren(banner, h('strong', { textContent: 'History is off. ' }), 'New pages are not being remembered. ',
      h('button', { className: 'link-btn', type: 'button', textContent: 'Turn it on', onclick: openSettings }))
  }
}

export function renderEmpty (query: string): HTMLElement {
  return h('div', { className: 'empty empty-state' }, clockIcon(),
    h('p', { textContent: query === '' ? 'Pages you visit appear here.' : `No page matches "${query}".` }))
}
