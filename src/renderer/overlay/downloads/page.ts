// The downloads bubble: the most recent files with what can be done to each, a held file's Keep and Discard,
// and a way to the full page. Main sends the rows and keeps them current; this draws them, moves focus and
// turns keys and clicks into requests that name a download by its id. The peek is the same page, opened by a
// new download: it never takes focus and tells main when the pointer is on it.
import type { DownloadEntry } from '../../../main/downloads/download-types.js'
import { h } from '../../pages/shared/dom.js'
import { closeIcon, downloadIcon, externalLinkIcon } from '../../pages/shared/icons.js'
import type { Overlay, OverlayPage } from '../kit.js'
import { isRemovable, primaryAction } from './line.js'
import type { BubbleActionId } from './line.js'
import { BubbleRow } from './row.js'
import './downloads.css'

const isRecord = (value: unknown): value is Record<string, unknown> => typeof value === 'object' && value !== null

/** The rows of a show or an update; anything that is not a row main builds is dropped. */
function asRows (payload: unknown): DownloadEntry[] {
  const list = isRecord(payload) ? payload['rows'] : undefined
  if (!Array.isArray(list)) return []
  return list.filter((row): row is DownloadEntry => isRecord(row) && typeof row['id'] === 'string' && typeof row['fileName'] === 'string' && typeof row['state'] === 'string')
}

export const downloadsPage: OverlayPage = {
  mount (content, overlay: Overlay) {
    const peek = overlay.name === 'downloads-peek'
    const rows = new Map<string, BubbleRow>()
    let current: string | null = null
    const list = h('ul', { className: 'dlb-list', role: 'list', ariaLabel: 'Downloads' })
    const empty = h('div', { className: 'empty-state compact', hidden: true }, downloadIcon(), h('p', { textContent: 'No downloads yet.' }))
    const openPage = (): void => { void overlay.request({ type: 'openPage' }) }
    const pageButton = h('button', { className: 'btn icon', type: 'button', title: 'Open downloads page', ariaLabel: 'Open downloads page', onclick: openPage }, externalLinkIcon())
    const dismiss = h('button', { className: 'btn icon', type: 'button', title: 'Dismiss', ariaLabel: 'Dismiss', hidden: !peek, onclick: () => { overlay.close() } }, closeIcon())
    content.append(
      h('div', { className: 'dlb-head' }, h('h2', { textContent: 'Downloads' }), h('div', { className: 'dlb-head-actions' }, dismiss, pageButton)),
      list,
      empty,
      h('div', { className: 'dlb-foot' }, h('button', { className: 'link-btn', type: 'button', textContent: 'Show all downloads', onclick: openPage })))

    const ordered = (): BubbleRow[] => Array.from(list.children).flatMap((el) => {
      const row = rows.get((el as HTMLElement).dataset['id'] ?? '')
      return row === undefined ? [] : [row]
    })

    function markCurrent (): void {
      for (const row of ordered()) row.element.tabIndex = row.entry.id === current ? 0 : -1
    }

    function act (action: BubbleActionId | 'open', entry: DownloadEntry): void {
      void overlay.request({ type: action, id: entry.id })
    }

    function activate (row: BubbleRow): void {
      const action = primaryAction(row.entry)
      if (action !== null) act(action, row.entry)
    }

    function build (entry: DownloadEntry): BubbleRow {
      const row = new BubbleRow(entry, act)
      row.element.addEventListener('click', () => { activate(row) })
      row.element.addEventListener('focusin', () => { current = row.entry.id; markCurrent() })
      return row
    }

    function focusedSpot (): { id: string, action: string | undefined } | null {
      const active = document.activeElement as HTMLElement | null
      const id = active?.closest<HTMLElement>('.dlb-row')?.dataset['id']
      return id === undefined || active === null ? null : { id, action: active.dataset['action'] }
    }

    function apply (entries: readonly DownloadEntry[]): void {
      const spot = focusedSpot()
      const before = ordered().map((row) => row.entry.id)
      const live = new Set(entries.map((entry) => entry.id))
      for (const [id, row] of rows) {
        if (live.has(id)) continue
        row.element.remove()
        rows.delete(id)
      }
      entries.forEach((entry, index) => {
        const known = rows.get(entry.id)
        const row = known ?? build(entry)
        if (known === undefined) rows.set(entry.id, row)
        else known.update(entry)
        if (list.children[index] !== row.element) list.insertBefore(row.element, list.children[index] ?? null)
      })
      list.hidden = entries.length === 0
      empty.hidden = entries.length > 0
      if (current === null || !live.has(current)) current = entries[0]?.id ?? null
      markCurrent()
      if (spot === null) return
      // A row that went away leaves focus on its neighbour; a row that moved is given it back.
      const target = rows.get(spot.id) ?? rows.get(before[Math.max(0, before.indexOf(spot.id) - 1)] ?? '') ?? ordered()[0]
      const button = target !== undefined && spot.action !== undefined ? target.button(spot.action as BubbleActionId) : null
      ;(button ?? target?.element)?.focus({ preventScroll: true })
    }

    function focusFirst (): void {
      const held = ordered().find((row) => row.entry.state === 'held')
      const target = held?.button('discard') ?? ordered()[0]?.element
      target?.focus({ preventScroll: true })
    }

    list.addEventListener('keydown', (event) => {
      if (event.altKey || event.ctrlKey || event.metaKey) return
      const target = event.target as HTMLElement
      const all = ordered()
      const index = all.findIndex((row) => row.element === target.closest('.dlb-row'))
      const row = all[index]
      if (row === undefined) return
      const move = (to: BubbleRow | undefined): void => { to?.element.focus() }
      switch (event.key) {
        case 'ArrowDown': move(all[Math.min(index + 1, all.length - 1)]); break
        case 'ArrowUp': move(all[Math.max(index - 1, 0)]); break
        case 'Home': move(all[0]); break
        case 'End': move(all.at(-1)); break
        case 'Enter':
          // On a button, Enter is the button's own.
          if (target !== row.element) return
          activate(row)
          break
        case 'Delete':
          if (!isRemovable(row.entry)) return
          act('remove', row.entry)
          break
        default: return
      }
      event.preventDefault()
    })

    if (peek) {
      document.body.addEventListener('pointerenter', () => { void overlay.request({ type: 'hold' }) })
      document.body.addEventListener('pointerleave', () => { void overlay.request({ type: 'release' }) })
    }
    overlay.onEvent((event) => {
      if (isRecord(event) && event['type'] === 'rows') apply(asRows(event))
    })

    return {
      shown: (payload) => {
        apply(asRows(payload))
        if (!peek) focusFirst()
      }
    }
  }
}
