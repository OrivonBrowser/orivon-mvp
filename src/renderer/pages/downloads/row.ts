// One download's row. It is built once and then patched as the download changes, so a row that is being
// pointed at, or has focus, is never replaced under the person.
import type { DownloadEntry } from '../../../main/downloads/download-types.js'
import { h } from '../shared/dom.js'
import { checkIcon, closeIcon, fileIcon, folderOpenIcon, pauseIcon, playIcon, refreshIcon, trashIcon, warningIcon } from '../shared/icons.js'
import { actionsFor, opensFile } from './actions.js'
import type { ActionId, RowAction } from './actions.js'
import { fractionOf, reasonText, sourceLabel, statusLine } from './format.js'
import { timeLabel } from '../history/days.js'

const ICONS: Readonly<Record<ActionId, () => SVGSVGElement>> = {
  pause: pauseIcon,
  resume: playIcon,
  cancel: closeIcon,
  retry: refreshIcon,
  remove: closeIcon,
  showInFolder: folderOpenIcon,
  deleteFile: trashIcon,
  keep: checkIcon,
  discard: trashIcon
}

const DISARM_MS = 4000

export interface RowHandlers {
  act: (action: ActionId, entry: DownloadEntry) => void
  open: (entry: DownloadEntry) => void
}

export class DownloadRow {
  readonly element: HTMLElement
  entry: DownloadEntry
  private readonly nameSlot = h('div', { className: 'dl-name' })
  private readonly source = h('div', { className: 'dl-source' })
  private readonly badge = h('span', { className: 'badge', hidden: true })
  private readonly statusText = h('span', { className: 'dl-status-text' })
  private readonly progress = h('div', { className: 'progress', hidden: true }, h('div', { className: 'progress-bar' }))
  private readonly actions = h('div', { className: 'dl-actions' })
  private readonly time = h('span', { className: 'dl-time' })
  private readonly icon = h('span', { className: 'dl-icon' }, fileIcon())
  private held = false
  private nameMode: 'link' | 'text' | null = null
  private armed: { readonly id: ActionId, readonly timer: ReturnType<typeof setTimeout> } | null = null

  constructor (entry: DownloadEntry, private readonly handlers: RowHandlers) {
    this.entry = entry
    this.element = h('div', { className: 'download', role: 'listitem', tabIndex: -1 },
      this.icon,
      h('div', { className: 'dl-main' },
        this.nameSlot,
        this.source,
        h('div', { className: 'dl-status' }, this.badge, this.statusText),
        this.progress),
      this.actions,
      this.time)
    this.element.dataset['id'] = entry.id
    this.update(entry)
  }

  update (entry: DownloadEntry): void {
    const stateChanged = entry.state !== this.entry.state || entry.missing !== this.entry.missing
    this.entry = entry
    if (stateChanged) this.disarm()
    this.element.className = `download is-${entry.state}${entry.missing === true ? ' is-missing' : ''}${entry.danger ? ' is-danger' : ''}`
    this.renderIcon()
    this.renderName()
    this.source.textContent = sourceLabel(entry.url)
    this.source.title = entry.url
    this.renderStatus()
    this.renderProgress()
    this.time.textContent = entry.endedAt !== undefined && entry.state !== 'progressing' && entry.state !== 'paused' ? timeLabel(entry.endedAt) : ''
    this.syncActions()
  }

  /** The action button with this id, for moving focus to it. */
  button (id: ActionId): HTMLButtonElement | null {
    return this.actions.querySelector<HTMLButtonElement>(`[data-action="${id}"]`)
  }

  /** Stops a pending two-click confirmation's timer. */
  dispose (): void {
    this.disarm()
  }

  /** A file held as dangerous shows the warning mark in place of the file's. */
  private renderIcon (): void {
    const held = this.entry.state === 'held'
    if (held === this.held && this.icon.firstChild !== null) return
    this.held = held
    this.icon.replaceChildren(held ? warningIcon() : fileIcon())
  }

  private renderName (): void {
    const { entry } = this
    const mode = opensFile(entry) ? 'link' : 'text'
    if (mode !== this.nameMode) {
      this.nameMode = mode
      this.nameSlot.replaceChildren(mode === 'link'
        ? h('button', { className: 'link-btn dl-name-link', type: 'button', onclick: () => { this.handlers.open(this.entry) } })
        : h('span', { className: 'dl-name-text' }))
    }
    const name = this.nameSlot.firstElementChild as HTMLElement
    name.textContent = entry.fileName
    name.title = entry.fileName
  }

  private renderStatus (): void {
    const { entry } = this
    const failed = entry.state === 'interrupted'
    const warn = entry.state === 'completed' && entry.danger && entry.missing !== true
    this.badge.hidden = !failed && !warn
    this.badge.className = failed ? 'badge danger' : 'badge warn'
    this.badge.textContent = failed ? 'Failed' : warn ? 'Open it from the folder' : ''
    this.statusText.textContent = failed ? reasonText(entry.reason) : statusLine(entry)
  }

  private renderProgress (): void {
    const { entry } = this
    const shown = entry.state === 'progressing' || entry.state === 'paused'
    this.progress.hidden = !shown
    const fraction = fractionOf(entry)
    const indeterminate = shown && fraction === null
    this.progress.className = `progress${indeterminate ? ' indeterminate' : ''}${entry.state === 'paused' ? ' is-paused' : ''}`
    this.progress.style.setProperty('--value', String(fraction ?? 0))
  }

  /** Keeps the buttons that stay, so a focused one keeps focus while its neighbours come and go. */
  private syncActions (): void {
    const wanted = actionsFor(this.entry)
    const have = new Map(Array.from(this.actions.children).map((child) => [(child as HTMLElement).dataset['action'], child as HTMLButtonElement]))
    for (const [id, button] of have) {
      if (!wanted.some((action) => action.id === id)) button.remove()
    }
    wanted.forEach((action, index) => {
      const button = have.get(action.id) ?? this.makeButton(action)
      if (this.actions.children[index] !== button) this.actions.insertBefore(button, this.actions.children[index] ?? null)
      this.labelButton(button, action)
    })
  }

  private makeButton (action: RowAction): HTMLButtonElement {
    const button = action.text === true
      ? h('button', { className: 'btn small', type: 'button', textContent: action.label })
      : h('button', { className: 'btn icon', type: 'button' }, ICONS[action.id]())
    button.dataset['action'] = action.id
    button.addEventListener('click', () => { this.press(action) })
    return button
  }

  private labelButton (button: HTMLButtonElement, action: RowAction): void {
    const armed = this.armed?.id === action.id
    const label = armed && action.confirm !== undefined ? action.confirm.label : action.label
    button.classList.toggle('danger', armed)
    button.classList.toggle('armed', armed)
    button.title = label
    button.setAttribute('aria-label', `${label} ${this.entry.fileName}`)
  }

  private press (action: RowAction): void {
    if (action.confirm !== undefined && this.armed?.id !== action.id) {
      this.disarm()
      this.armed = { id: action.id, timer: setTimeout(() => { this.disarm() }, DISARM_MS) }
      this.syncActions()
      return
    }
    this.disarm()
    this.handlers.act(action.id, this.entry)
  }

  private disarm (): void {
    if (this.armed === null) return
    clearTimeout(this.armed.timer)
    this.armed = null
    this.syncActions()
  }
}
