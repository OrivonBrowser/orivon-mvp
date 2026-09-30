// One row of the downloads bubble. Built once and patched as the download changes, so a row that is pointed
// at or holds focus is never replaced under the person.
import type { DownloadEntry } from '../../../main/downloads/download-types.js'
import { h } from '../../pages/shared/dom.js'
import { closeIcon, fileIcon, folderOpenIcon, pauseIcon, playIcon, refreshIcon, warningIcon } from '../../pages/shared/icons.js'
import { fractionOf } from '../../pages/shared/format-bytes.js'
import { lineFor, rowActions, showsFolderBadge } from './line.js'
import type { BubbleAction, BubbleActionId } from './line.js'

const ICONS: Readonly<Record<BubbleActionId, (() => SVGSVGElement) | null>> = {
  pause: pauseIcon,
  resume: playIcon,
  cancel: closeIcon,
  retry: refreshIcon,
  remove: null,
  showInFolder: folderOpenIcon,
  keep: null,
  discard: null
}

export class BubbleRow {
  readonly element: HTMLElement
  entry: DownloadEntry
  private readonly icon = h('span', { className: 'dlb-icon' }, fileIcon())
  private readonly name = h('div', { className: 'dlb-name' })
  private readonly line = h('span', { className: 'dlb-line-text' })
  private readonly badge = h('span', { className: 'badge warn', hidden: true, textContent: 'Open it from the folder' })
  private readonly progress = h('div', { className: 'progress', hidden: true }, h('div', { className: 'progress-bar' }))
  private readonly actions = h('div', { className: 'dlb-actions' })
  private held = false

  constructor (entry: DownloadEntry, private readonly act: (action: BubbleActionId, entry: DownloadEntry) => void) {
    this.entry = entry
    this.element = h('li', { className: 'dlb-row', role: 'listitem', tabIndex: -1 },
      this.icon,
      h('div', { className: 'dlb-main' }, this.name, h('div', { className: 'dlb-line' }, this.line, this.badge), this.progress),
      this.actions)
    this.element.dataset['id'] = entry.id
    this.update(entry)
  }

  update (entry: DownloadEntry): void {
    this.entry = entry
    this.element.className = `dlb-row is-${entry.state}${entry.danger ? ' is-danger' : ''}${entry.missing === true ? ' is-missing' : ''}`
    const held = entry.state === 'held'
    if (held !== this.held) {
      this.held = held
      this.icon.replaceChildren(held ? warningIcon() : fileIcon())
    }
    this.name.textContent = entry.fileName
    this.name.title = entry.fileName
    this.line.textContent = lineFor(entry)
    this.badge.hidden = !showsFolderBadge(entry)
    const shown = entry.state === 'progressing' || entry.state === 'paused'
    const fraction = fractionOf(entry)
    this.progress.hidden = !shown
    this.progress.className = `progress${shown && fraction === null && entry.state === 'progressing' ? ' indeterminate' : ''}${entry.state === 'paused' ? ' is-paused' : ''}`
    this.progress.style.setProperty('--value', String(fraction ?? 0))
    this.syncActions()
  }

  /** The action button with this id, for moving focus to it. */
  button (id: BubbleActionId): HTMLButtonElement | null {
    return this.actions.querySelector<HTMLButtonElement>(`[data-action="${id}"]`)
  }

  /** Keeps the buttons that stay, so a focused one keeps focus while its neighbours come and go. */
  private syncActions (): void {
    const wanted = rowActions(this.entry)
    const have = new Map(Array.from(this.actions.children).map((child) => [(child as HTMLElement).dataset['action'], child as HTMLButtonElement]))
    for (const [id, button] of have) if (!wanted.some((action) => action.id === id)) button.remove()
    wanted.forEach((action, index) => {
      const button = have.get(action.id) ?? this.makeButton(action)
      if (this.actions.children[index] !== button) this.actions.insertBefore(button, this.actions.children[index] ?? null)
      button.title = action.label
      button.setAttribute('aria-label', `${action.label} ${this.entry.fileName}`)
    })
    this.actions.classList.toggle('reveal', wanted.every((action) => action.reveal === true))
  }

  private makeButton (action: BubbleAction): HTMLButtonElement {
    const icon = ICONS[action.id]
    const button = action.text === true || icon === null
      ? h('button', { className: 'btn small', type: 'button', textContent: action.label })
      : h('button', { className: 'btn icon', type: 'button' }, icon())
    button.dataset['action'] = action.id
    button.addEventListener('click', (event) => { event.stopPropagation(); this.act(action.id, this.entry) })
    return button
  }
}
