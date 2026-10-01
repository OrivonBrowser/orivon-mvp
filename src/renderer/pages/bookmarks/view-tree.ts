// The folder tree at the left: the bar and Other bookmarks and the folders in them, one at a time in the tab order.
// A folder is chosen by click or Enter; the chevron only opens or closes it.
import { h } from '../shared/dom.js'
import { folderIcon, folderOpenIcon } from '../shared/icons.js'
import type { FolderInfo } from './folder-tree.js'

export interface TreeActions {
  /** Go to the folder. */
  choose: (id: string) => void
  toggle: (id: string) => void
}

export interface TreeView {
  readonly folders: readonly FolderInfo[]
  readonly expanded: ReadonlySet<string>
  /** The folder the list shows, or null while a search has the list. */
  readonly current: string | null
  readonly focusId: string | null
}

export function renderTree (view: TreeView, actions: TreeActions): HTMLElement {
  const items = view.folders.map((folder) => {
    const open = view.expanded.has(folder.id)
    const chosen = folder.id === view.current
    const toggle = h('button', { className: 'tree-toggle', type: 'button', tabIndex: -1, onclick: (event: MouseEvent) => { event.stopPropagation(); actions.toggle(folder.id) } })
    toggle.setAttribute('aria-label', `${open ? 'Collapse' : 'Expand'} ${folder.title}`)
    const item = h('li', { className: 'tree-item', role: 'treeitem', tabIndex: folder.id === view.focusId ? 0 : -1, title: folder.title },
      toggle,
      h('span', { className: 'item-icon' }, open && folder.folders > 0 ? folderOpenIcon() : folderIcon()),
      h('span', { className: 'tree-label', textContent: folder.title }))
    item.dataset['id'] = folder.id
    item.style.setProperty('--level', String(folder.depth))
    item.setAttribute('aria-level', String(folder.depth + 1))
    item.setAttribute('aria-selected', String(chosen))
    if (folder.folders > 0) item.setAttribute('aria-expanded', String(open))
    else toggle.disabled = true
    item.addEventListener('click', () => { actions.choose(folder.id) })
    return item
  })
  const tree = h('ul', { className: 'tree', role: 'tree' }, ...items)
  tree.setAttribute('aria-label', 'Folders')
  return tree
}

export function treeItem (root: ParentNode, id: string | null): HTMLElement | null {
  return id === null ? null : root.querySelector<HTMLElement>(`.tree-item[data-id="${CSS.escape(id)}"]`)
}
