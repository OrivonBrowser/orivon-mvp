// "Move to…": a dialog inside the page with the folders to file the chosen rows in. The folders being moved, and
// those inside them, are shown but cannot be chosen. The keys stay in the dialog until it closes.
import { h } from '../shared/dom.js'
import { folderIcon } from '../shared/icons.js'
import { step } from '../shared/list-selection.js'
import { folderBranch } from './folder-tree.js'
import type { FolderInfo } from './folder-tree.js'

export interface MoveSheet {
  readonly folders: readonly FolderInfo[]
  /** The folders among the rows being moved. */
  readonly moving: readonly string[]
  /** What is chosen to begin with. */
  readonly initial: string
  readonly summary: string
  readonly move: (parent: string) => void
  readonly closed: () => void
}

export function openMoveSheet (sheet: MoveSheet): void {
  const blocked = new Set(sheet.moving.flatMap((id) => [...folderBranch(sheet.folders, id)]))
  const choices = sheet.folders.filter((folder) => !blocked.has(folder.id)).map((folder) => folder.id)
  let chosen = choices.includes(sheet.initial) ? sheet.initial : choices[0] ?? ''

  const items = new Map<string, HTMLElement>()
  for (const folder of sheet.folders) {
    const disabled = blocked.has(folder.id)
    const item = h('li', { className: 'tree-item', role: 'treeitem', title: folder.title },
      h('span', { className: 'tree-toggle' }),
      h('span', { className: 'item-icon' }, folderIcon()),
      h('span', { className: 'tree-label', textContent: folder.title }))
    item.dataset['id'] = folder.id
    item.style.setProperty('--level', String(folder.depth))
    item.setAttribute('aria-level', String(folder.depth + 1))
    if (disabled) item.setAttribute('aria-disabled', 'true')
    else {
      item.addEventListener('click', () => { choose(folder.id) })
      item.addEventListener('dblclick', () => { confirm() })
    }
    items.set(folder.id, item)
  }
  const tree = h('ul', { className: 'tree move-tree', role: 'tree' }, ...items.values())
  tree.setAttribute('aria-label', 'Folders')
  const cancel = h('button', { className: 'btn', type: 'button', textContent: 'Cancel' })
  const move = h('button', { className: 'btn primary', type: 'button', textContent: 'Move' })
  const title = h('h2', { className: 'sheet-title', id: 'move-title', textContent: 'Move to…' })
  const dialog = h('div', { className: 'sheet move-sheet', role: 'dialog' }, title,
    h('p', { className: 'sheet-note', textContent: sheet.summary }), tree, h('div', { className: 'btn-row' }, cancel, move))
  dialog.setAttribute('aria-modal', 'true')
  dialog.setAttribute('aria-labelledby', 'move-title')
  const scrim = h('div', { className: 'scrim' }, dialog)

  function choose (id: string): void {
    chosen = id
    for (const [key, item] of items) {
      item.setAttribute('aria-selected', String(key === chosen))
      item.tabIndex = key === chosen ? 0 : -1
    }
    move.disabled = chosen === ''
  }
  let done = false
  function close (): void {
    if (done) return
    done = true
    scrim.remove()
    sheet.closed()
  }
  function confirm (): void {
    if (chosen === '' || done) return
    const parent = chosen
    close()
    sheet.move(parent)
  }

  cancel.addEventListener('click', close)
  move.addEventListener('click', confirm)
  scrim.addEventListener('pointerdown', (event) => { if (event.target === scrim) close() })
  scrim.addEventListener('keydown', (event) => {
    if (event.key === 'Escape') { event.preventDefault(); event.stopPropagation(); close(); return }
    if (event.key === 'Tab') {
      const stops = [items.get(chosen), cancel, move].filter((el): el is HTMLElement => el !== undefined && !(el instanceof HTMLButtonElement && el.disabled))
      const at = stops.indexOf(document.activeElement as HTMLElement)
      const next = stops[(at + (event.shiftKey ? -1 : 1) + stops.length) % stops.length]
      event.preventDefault()
      next?.focus()
      return
    }
    const target = (event.target as HTMLElement).closest<HTMLElement>('.tree-item')
    if (target === null) return
    const how = event.key === 'ArrowUp' ? 'up' : event.key === 'ArrowDown' ? 'down' : event.key === 'Home' ? 'first' : event.key === 'End' ? 'last' : null
    if (how !== null) {
      event.preventDefault()
      const next = step(choices, chosen, how)
      if (next !== null) { choose(next); items.get(next)?.focus(); items.get(next)?.scrollIntoView({ block: 'nearest' }) }
    } else if (event.key === 'Enter') {
      event.preventDefault()
      confirm()
    }
  })

  choose(chosen)
  document.body.append(scrim)
  items.get(chosen)?.focus()
}
