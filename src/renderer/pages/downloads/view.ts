// The Downloads page's document: the header, the list grouped by day, and the keys that move through it.
// A change to one download patches its row; only a change to the list itself builds the list again.
import type { DownloadEntry } from '../../../main/downloads/download-types.js'
import { h, replaceChildren } from '../shared/dom.js'
import { downloadIcon } from '../shared/icons.js'
import { isRemovable, spaceAction } from './actions.js'
import type { ActionId } from './actions.js'
import { groupByStartDay } from './format.js'
import { DownloadRow } from './row.js'
import type { DownloadsState } from './state.js'

/** A fetch that takes longer than this shows placeholder rows instead of a blank page. */
const SKELETON_DELAY_MS = 150
const DISARM_MS = 4000

export class DownloadsView {
  private readonly rows = new Map<string, DownloadRow>()
  private readonly list = h('div', { className: 'list', role: 'list' })
  private readonly folderLine = h('p', { className: 'folder-line' })
  private readonly banner = h('div', { className: 'banner info', hidden: true, role: 'status' })
  private readonly clearButton = h('button', { className: 'btn danger', type: 'button', textContent: 'Clear list', disabled: true })
  private current: string | null = null
  private skeletonTimer: ReturnType<typeof setTimeout> | undefined
  private disarmTimer: ReturnType<typeof setTimeout> | undefined

  constructor (private readonly state: DownloadsState) {
    this.list.setAttribute('aria-label', 'Downloads')
    this.list.addEventListener('keydown', (event) => { this.onKey(event) })
    this.list.addEventListener('focusin', (event) => { this.noteFocus(event.target) })
    this.clearButton.addEventListener('click', () => { this.clear() })
    this.skeletonTimer = setTimeout(() => { if (!state.loaded) this.renderSkeleton() }, SKELETON_DELAY_MS)
    state.onChange((change) => {
      if (change.kind === 'entry') this.patch(change.id)
      else this.renderAll()
    })
  }

  mount (root: HTMLElement): void {
    root.append(h('main', { className: 'page' },
      h('header', { className: 'head' },
        h('div', { className: 'head-text' },
          h('h1', null, downloadIcon(), 'Downloads'),
          this.folderLine),
        h('div', { className: 'head-actions' },
          h('button', { className: 'btn', type: 'button', textContent: 'Open downloads folder', onclick: () => { void this.state.openFolder() } }),
          this.clearButton)),
      this.banner,
      this.list))
  }

  private renderSkeleton (): void {
    replaceChildren(this.list, ...[0, 1, 2].map(() => this.skeletonRow()))
  }

  private skeletonRow (): HTMLElement {
    const row = h('div', { className: 'download skeleton-row' },
      h('span', { className: 'skeleton dl-skeleton-icon' }),
      h('div', { className: 'dl-main' }, h('span', { className: 'skeleton dl-skeleton-name' }), h('span', { className: 'skeleton dl-skeleton-line' })))
    row.setAttribute('aria-hidden', 'true')
    return row
  }

  /** Builds the list again, from the state. A row that is already there is kept, and focus stays where it was. */
  private renderAll (): void {
    clearTimeout(this.skeletonTimer)
    const { entries } = this.state
    const focused = this.focusedSpot()
    const live = new Set(entries.map((entry) => entry.id))
    for (const [id, row] of this.rows) {
      if (live.has(id)) continue
      row.dispose()
      this.rows.delete(id)
    }
    this.folderLine.textContent = this.state.folder === '' ? '' : `Saved to ${this.state.folder}`
    this.folderLine.title = this.state.folder
    this.banner.hidden = !this.state.isPrivate
    replaceChildren(this.banner, this.state.isPrivate ? 'Files you download in a private window stay on this computer. This list is forgotten when the window closes.' : null)
    this.clearButton.disabled = !this.state.clearable
    if (entries.length === 0) {
      replaceChildren(this.list, h('div', { className: 'empty-state' }, downloadIcon(), h('p', { textContent: 'Files you download appear here.' })))
      return
    }
    const ids = new Set(entries.map((entry) => entry.id))
    if (this.current === null || !ids.has(this.current)) this.current = entries[0]?.id ?? null
    replaceChildren(this.list, ...groupByStartDay(entries, Date.now()).map((group) => h('section', { className: 'day' },
      h('h2', { textContent: group.label }),
      h('div', { className: 'entries' }, ...group.entries.map((entry) => this.rowFor(entry).element)))))
    this.markCurrent()
    this.restoreFocus(focused)
  }

  private rowFor (entry: DownloadEntry): DownloadRow {
    const known = this.rows.get(entry.id)
    if (known !== undefined) {
      known.update(entry)
      return known
    }
    const row = new DownloadRow(entry, {
      act: (action, target) => { void this.act(action, target) },
      open: (target) => { void this.state.open(target.id) }
    })
    this.rows.set(entry.id, row)
    return row
  }

  private patch (id: string): void {
    const entry = this.state.find(id)
    const row = this.rows.get(id)
    if (entry === undefined || row === undefined) { this.renderAll(); return }
    row.update(entry)
    this.clearButton.disabled = !this.state.clearable
  }

  private async act (action: ActionId, entry: DownloadEntry): Promise<void> {
    if (action === 'remove') this.moveCurrentAway(entry.id)
    await this.state.act(action, entry.id)
  }

  private clear (): void {
    if (this.disarmTimer === undefined) {
      this.clearButton.textContent = 'Click again to clear'
      this.clearButton.classList.add('armed')
      this.disarmTimer = setTimeout(() => { this.disarm() }, DISARM_MS)
      return
    }
    this.disarm()
    void this.state.clear()
  }

  private disarm (): void {
    clearTimeout(this.disarmTimer)
    this.disarmTimer = undefined
    this.clearButton.textContent = 'Clear list'
    this.clearButton.classList.remove('armed')
  }

  private orderedRows (): DownloadRow[] {
    return Array.from(this.list.querySelectorAll<HTMLElement>('.download')).flatMap((element) => {
      const row = this.rows.get(element.dataset['id'] ?? '')
      return row === undefined ? [] : [row]
    })
  }

  /** Only one row is a Tab stop; the arrow keys move it, and the buttons inside every row stay reachable in reading order. */
  private markCurrent (): void {
    for (const row of this.orderedRows()) row.element.tabIndex = row.entry.id === this.current ? 0 : -1
  }

  private noteFocus (target: EventTarget | null): void {
    const id = (target as HTMLElement | null)?.closest<HTMLElement>('.download')?.dataset['id']
    if (id === undefined || id === this.current) return
    this.current = id
    this.markCurrent()
  }

  private focusRow (row: DownloadRow | undefined): void {
    if (row === undefined) return
    this.current = row.entry.id
    this.markCurrent()
    row.element.focus()
  }

  /** After a removal the row beside it is where the keys continue from. */
  private moveCurrentAway (id: string): void {
    const rows = this.orderedRows()
    const index = rows.findIndex((row) => row.entry.id === id)
    const next = rows[index + 1] ?? rows[index - 1]
    if (next === undefined) return
    const hadFocus = this.list.contains(document.activeElement)
    this.current = next.entry.id
    this.markCurrent()
    if (hadFocus) next.element.focus()
  }

  private onKey (event: KeyboardEvent): void {
    if (event.altKey || event.ctrlKey || event.metaKey) return
    const target = event.target as HTMLElement
    const rowElement = target.closest<HTMLElement>('.download')
    const rows = this.orderedRows()
    const index = rows.findIndex((row) => row.element === rowElement)
    const row = rows[index]
    if (row === undefined) return
    switch (event.key) {
      case 'ArrowDown': this.focusRow(rows[Math.min(index + 1, rows.length - 1)]); break
      case 'ArrowUp': this.focusRow(rows[Math.max(index - 1, 0)]); break
      case 'Home': this.focusRow(rows[0]); break
      case 'End': this.focusRow(rows.at(-1)); break
      case 'Delete':
      case 'Backspace':
        if (!isRemovable(row.entry)) return
        void this.act('remove', row.entry)
        break
      case ' ': {
        // On a button, Space is the button's own.
        const action = target === row.element ? spaceAction(row.entry) : null
        if (action === null) return
        void this.act(action, row.entry)
        break
      }
      default: return
    }
    event.preventDefault()
  }

  private focusedSpot (): { readonly id: string, readonly action: string | undefined } | null {
    const active = document.activeElement as HTMLElement | null
    const id = active?.closest<HTMLElement>('.download')?.dataset['id']
    return id === undefined || active === null || !this.list.contains(active) ? null : { id, action: active.dataset['action'] }
  }

  private restoreFocus (spot: { readonly id: string, readonly action: string | undefined } | null): void {
    if (spot === null) return
    const row = this.rows.get(spot.id)
    if (row === undefined) return
    const button = spot.action === undefined ? null : row.button(spot.action as ActionId)
    ;(button ?? row.element).focus({ preventScroll: true })
  }
}
