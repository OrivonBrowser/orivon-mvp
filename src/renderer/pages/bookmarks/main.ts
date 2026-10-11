// The Bookmarks page: every bookmark and folder in a tree and a list, with search, editing in place, filing rows in
// folders by dialog or drag, delete with undo, and the bookmarks saved as the HTML file other browsers read.
import { coalesce } from '../shared/coalesce.js'
import { h, replaceChildren } from '../shared/dom.js'
import { bookmarkIcon, moreIcon, plusIcon } from '../shared/icons.js'
import * as selection from '../shared/list-selection.js'
import { closeRowMenu, openRowMenu } from '../shared/row-menu.js'
import { createActions } from './actions.js'
import { installDrag } from './drag.js'
import { listIntent, treeIntent } from './keys.js'
import { refresh } from './load.js'
import { DEFAULT_FOLDER, folderFromPath, pathForFolder } from './router.js'
import { folderBranch, parentFolder, visibleFolders } from './folder-tree.js'
import { CHUNK, listed, listedIds, onEvent, platform, request, rowById, state } from './state.js'
import { pendingToastAction, toastRegion } from './toast.js'
import { renderEdit } from './view-edit.js'
import { applyRoving, applySelection, renderCrumbs, renderEmpty, renderList, renderSkeleton, rowElement } from './view-list.js'
import type { RowActions } from './view-list.js'
import { renderTree, treeItem } from './view-tree.js'

const SEARCH_DELAY_MS = 200
const ADDRESS_PROBLEM = 'Enter a web address that starts with http:// or https://'

const search = h('input', { className: 'text search', type: 'search', placeholder: 'Search bookmarks', autocomplete: 'off', spellcheck: false })
search.setAttribute('aria-label', 'Search bookmarks')
const newFolderButton = h('button', { className: 'btn', type: 'button' }, plusIcon(), 'New folder')
const moreButton = h('button', { className: 'btn icon', type: 'button', title: 'More' }, moreIcon())
moreButton.setAttribute('aria-label', 'More')
moreButton.setAttribute('aria-haspopup', 'menu')
const banner = h('div', { className: 'banner info', hidden: true, role: 'status', textContent: 'Bookmarks added in a private window are forgotten when it closes.' })
const treeHost = h('aside', { className: 'tree-pane' })
const crumbsHost = h('div', { className: 'crumbs-host' })
const bodyHost = h('div', { className: 'body-host' })
const pane = h('div', { className: 'list-scroll' }, bodyHost)

let reloadWanted = false

const busy = (): boolean => state.editing !== null || document.querySelector('.scrim') !== null || document.body.classList.contains('dragging')

function settle (): void {
  if (reloadWanted && !busy()) { reloadWanted = false; void refresh().then(() => { render() }) }
}

const focusRow = (): void => { (rowElement(bodyHost, state.focusId) ?? bodyHost.querySelector<HTMLElement>('.bm-row[data-id]'))?.focus() }

async function go (id: string, choose?: string[]): Promise<void> {
  if (state.query !== '') { search.value = ''; state.query = ''; state.results = null }
  state.editing = null
  state.current = id
  state.shown = CHUNK
  state.selected = new Set(choose ?? [])
  state.anchor = choose?.[0] ?? null
  state.focusId = choose?.[0] ?? null
  if (location.pathname !== pathForFolder(id)) history.pushState(null, '', pathForFolder(id))
  await refresh()
  if (location.pathname !== pathForFolder(state.current)) history.replaceState(null, '', pathForFolder(state.current))
  render(choose !== undefined)
  if (choose === undefined) pane.scrollTop = 0
}

async function clearSearch (): Promise<void> {
  search.value = ''
  state.query = ''
  state.results = null
  await refresh()
  render()
}

const actions = createActions({
  render: (focus) => { render(focus) },
  go,
  clearSearch,
  settle,
  returnFocus: focusRow
})

async function saveEdit (id: string, title: string, url: string | null): Promise<string | null> {
  const row = rowById(id)
  const editing = state.editing
  if (row === undefined || editing === null) return null
  const name = title.trim()
  const patch: { id: string, title?: string, url?: string } = { id }
  if (row.kind === 'folder' && name === '') { stopEditing(); return null }
  if (name !== row.title) patch.title = name
  if (url !== null && url !== row.url) patch.url = url
  if (patch.title !== undefined || patch.url !== undefined) {
    const reply = await request<{ ok: boolean, reason?: string }>({ type: 'update', ...patch })
    if (reply?.ok !== true && reply?.reason === 'url') return ADDRESS_PROBLEM
  }
  stopEditing()
  return null
}

function stopEditing (): void {
  if (state.editing === null) return
  state.editing = null
  void refresh().then(() => { render(true); settle() })
}

const rowActions: RowActions = {
  choose: (row, event) => {
    const ids = listedIds()
    if (event.ctrlKey || event.metaKey) { state.selected = selection.toggle(state.selected, row.id); state.anchor = row.id }
    else if (event.shiftKey) state.selected = selection.range(ids, state.anchor ?? state.focusId, row.id)
    else { state.selected = new Set([row.id]); state.anchor = row.id }
    state.focusId = row.id
    applySelection(bodyHost, state.selected)
    applyRoving(bodyHost, state.focusId)
  },
  open: (row, how) => { void actions.open(row, how) },
  enter: (row) => { void actions.open(row, 'tab') },
  menu: (row, place, opener) => { actions.rowMenu(row, place, opener) }
}

function render (focus = false): void {
  // The folder shown may not be the one the address names: it was deleted elsewhere and the page fell back.
  if (location.pathname !== pathForFolder(state.current)) history.replaceState(null, '', pathForFolder(state.current))
  const active = document.activeElement as HTMLElement | null
  const listHadFocus = bodyHost.contains(active) && active?.closest('form') === null
  const treeHadFocus = treeHost.contains(active)
  const scroll = pane.scrollTop
  banner.hidden = !state.isPrivate
  const folders = visibleFolders(state.folders, state.expanded)
  if (!folders.some((folder) => folder.id === state.treeFocus)) state.treeFocus = folders.some((folder) => folder.id === state.current) ? state.current : folders[0]?.id ?? null
  replaceChildren(treeHost, renderTree({ folders, expanded: state.expanded, current: state.results === null ? state.current : null, focusId: state.treeFocus }, {
    choose: (id) => { void go(id) },
    toggle: (id) => { if (!state.expanded.delete(id)) state.expanded.add(id); render() }
  }))
  const searching = state.results !== null
  const rows = listed()
  replaceChildren(crumbsHost, state.loaded ? renderCrumbs(state.crumbs, searching, rows.length, (id) => { void go(id) }, state.moreResults) : null)
  const view = { selected: state.selected, query: state.query, searching, focusId: state.focusId, shown: state.shown }
  if (!state.loaded) replaceChildren(bodyHost, renderSkeleton())
  else if (rows.length === 0) {
    const storeEmpty = state.folders.filter((folder) => folder.depth === 0).every((folder) => folder.items === 0)
    replaceChildren(bodyHost, renderEmpty({ query: state.query, storeEmpty, importAvailable: state.importAvailable, importBookmarks: () => { void request({ type: 'import' }) }, platform }))
  } else {
    replaceChildren(bodyHost, renderList(rows, view, rowActions, () => { state.shown += CHUNK; render() }))
    const editing = state.editing
    const row = editing === null ? undefined : rowById(editing.id)
    if (editing !== null && row !== undefined) {
      rowElement(bodyHost, editing.id)?.replaceWith(renderEdit(row, { save: async (title, url) => await saveEdit(editing.id, title, url), cancel: stopEditing }))
    }
    applyRoving(bodyHost, state.focusId)
  }
  pane.scrollTop = scroll
  if (state.editing !== null) return
  if (focus || listHadFocus) focusRow()
  else if (treeHadFocus) treeItem(treeHost, state.treeFocus)?.focus()
  const current = treeItem(treeHost, state.current)
  if (current !== null && !treeHost.contains(document.activeElement)) current.scrollIntoView({ block: 'nearest' })
}

// Keys: the list, the tree, and the few that work anywhere.
const isField = (target: EventTarget | null): boolean => target instanceof HTMLInputElement || target instanceof HTMLTextAreaElement || target instanceof HTMLSelectElement

function listKey (event: KeyboardEvent, rowEl: HTMLElement): void {
  const intent = listIntent({ key: event.key, ctrlKey: event.ctrlKey, metaKey: event.metaKey, shiftKey: event.shiftKey, altKey: event.altKey, inField: isField(event.target), mac: platform === 'darwin' })
  if (intent === null) return
  const id = rowEl.dataset['id'] ?? null
  const row = rowById(id)
  const ids = listedIds()
  event.preventDefault()
  switch (intent.kind) {
    case 'escape': if (state.selected.size > 0) { state.selected = new Set(); applySelection(bodyHost, state.selected) } return
    case 'search': search.focus(); search.select(); return
    case 'all': state.selected = selection.all(ids); applySelection(bodyHost, state.selected); return
    case 'move': {
      const next = selection.step(ids, id, intent.to)
      if (next === null) return
      if (intent.extend) { state.anchor ??= id; state.selected = selection.range(ids, state.anchor, next) } else { state.selected = new Set([next]); state.anchor = next }
      state.focusId = next
      if (ids.indexOf(next) >= state.shown) { state.shown = ids.indexOf(next) + CHUNK; render(true); return }
      applySelection(bodyHost, state.selected)
      applyRoving(bodyHost, next)
      const el = rowElement(bodyHost, next)
      el?.focus()
      el?.scrollIntoView({ block: 'nearest' })
      return
    }
    case 'toggle': if (id !== null) { state.selected = selection.toggle(state.selected, id); state.anchor = id; applySelection(bodyHost, state.selected) } return
    case 'open': if (row !== undefined) void actions.open(row, intent.background ? 'background' : 'tab'); return
    case 'parent': { const parent = state.crumbs.at(-2); if (parent !== undefined && state.results === null) void go(parent.id, [state.current]); return }
    case 'edit': if (row !== undefined) actions.rename(row); return
    case 'delete': if (row !== undefined) void actions.remove(actions.targets(row)); return
    case 'nudge': void actions.nudge(intent.direction, row); return
    case 'menu': {
      if (row === undefined) return
      const box = rowEl.getBoundingClientRect()
      actions.rowMenu(row, { x: box.left + 32, y: box.bottom, alignRight: false }, rowEl)
    }
  }
}

function treeKey (event: KeyboardEvent, item: HTMLElement): void {
  const intent = treeIntent(event.key, event.ctrlKey || event.metaKey || event.altKey || event.shiftKey)
  const id = item.dataset['id'] ?? ''
  if (intent === null) return
  event.preventDefault()
  const folders = visibleFolders(state.folders, state.expanded)
  const info = state.folders.find((folder) => folder.id === id)
  const focusTo = (target: string | null): void => { if (target === null) return; state.treeFocus = target; render(); treeItem(treeHost, target)?.focus() }
  switch (intent.kind) {
    case 'move': focusTo(selection.step(folders.map((folder) => folder.id), id, intent.to)); return
    case 'select': void go(id); return
    case 'right':
      if (info === undefined) return
      if (info.folders === 0) void go(id)
      else if (!state.expanded.has(id)) { state.expanded.add(id); focusTo(id) } else focusTo(folders[folders.findIndex((folder) => folder.id === id) + 1]?.id ?? null)
      return
    case 'left':
      if (info !== undefined && info.folders > 0 && state.expanded.has(id)) { state.expanded.delete(id); focusTo(id) } else focusTo(parentFolder(state.folders, id)?.id ?? null)
  }
}

document.addEventListener('keydown', (event) => {
  if (event.defaultPrevented) return
  const target = event.target as HTMLElement
  if (target === search && event.key === 'Escape') { if (search.value !== '') { event.preventDefault(); void clearSearch() } return }
  if (target === search && event.key === 'ArrowDown') { event.preventDefault(); focusRow(); return }
  const mod = platform === 'darwin' ? event.metaKey : event.ctrlKey
  if (mod && event.key.toLowerCase() === 'z' && !isField(target)) {
    const undo = pendingToastAction()
    if (undo !== null) { event.preventDefault(); undo.click() }
    return
  }
  const rowEl = target.closest<HTMLElement>('.bm-row[data-id]')
  if (rowEl !== null && target === rowEl) { listKey(event, rowEl); return }
  const item = target.closest<HTMLElement>('.tree-item[data-id]')
  if (item !== null && treeHost.contains(item)) { treeKey(event, item); return }
  if (event.key === '/' && !isField(target) && !event.ctrlKey && !event.metaKey && !event.altKey) { event.preventDefault(); search.focus(); search.select() }
})

bodyHost.addEventListener('focusin', (event) => {
  const row = (event.target as HTMLElement).closest<HTMLElement>('.bm-row[data-id]')
  if (row === null || row.classList.contains('editing')) return
  state.focusId = row.dataset['id'] ?? null
  applyRoving(bodyHost, state.focusId)
})
treeHost.addEventListener('focusin', (event) => {
  const item = (event.target as HTMLElement).closest<HTMLElement>('.tree-item[data-id]')
  if (item !== null) state.treeFocus = item.dataset['id'] ?? null
})
pane.addEventListener('scroll', () => {
  if (pane.scrollTop + pane.clientHeight < pane.scrollHeight - 200 || listed().length <= state.shown) return
  state.shown += CHUNK
  render()
})

let searchTimer: ReturnType<typeof setTimeout> | undefined
search.addEventListener('input', () => {
  clearTimeout(searchTimer)
  searchTimer = setTimeout(() => {
    state.query = search.value.trim()
    state.shown = CHUNK
    if (state.query === '') state.results = null
    void refresh().then(() => { render() })
  }, SEARCH_DELAY_MS)
})
newFolderButton.addEventListener('click', () => { void actions.newFolder() })
moreButton.addEventListener('click', () => {
  const box = moreButton.getBoundingClientRect()
  openRowMenu([
    { label: 'Export bookmarks…', run: () => { void actions.exportFile() } },
    ...(state.importAvailable ? [{ label: 'Import bookmarks…', run: () => { void request({ type: 'import' }) } }] : [])
  ], { x: box.right, y: box.bottom + 4, alignRight: true }, () => { moreButton.focus() }, 'More')
})

installDrag({
  pane,
  tree: treeHost,
  enabled: () => state.results === null && state.editing === null && document.querySelector('.scrim') === null,
  grab: (id) => {
    if (!state.selected.has(id)) { state.selected = new Set([id]); state.anchor = id; applySelection(bodyHost, state.selected) }
    return listedIds().filter((each) => state.selected.has(each))
  },
  blocked: (ids) => new Set(ids.flatMap((id) => [...folderBranch(state.folders, id)])),
  folderIds: () => new Set(state.folders.map((folder) => folder.id)),
  drop: (ids, parent, index) => { void actions.move(ids, parent, index).then(settle) }
})

// A change from elsewhere (the bar, the star, another window) shows up here too, never under a form being typed in.
const reloadOnPush = coalesce(() => {
  if (document.visibilityState !== 'visible' || busy()) { reloadWanted = true; return }
  void refresh().then(() => { render() })
}, 150)
onEvent((topic) => { if (topic === 'bookmarks.changed') reloadOnPush() })
document.addEventListener('visibilitychange', () => { if (document.visibilityState === 'visible' && reloadWanted) settle() })
window.addEventListener('popstate', () => { void go(folderFromPath(location.pathname) ?? DEFAULT_FOLDER) })
window.addEventListener('blur', () => { closeRowMenu() })

document.getElementById('app')?.append(
  h('main', { className: 'page' },
    h('header', { className: 'head' },
      h('h1', null, bookmarkIcon(), 'Bookmarks'),
      h('div', { className: 'head-tools' }, search, newFolderButton, moreButton)),
    banner,
    h('div', { className: 'panes' }, treeHost, h('section', { className: 'list-pane' }, crumbsHost, pane))),
  toastRegion)

state.current = folderFromPath(location.pathname) ?? DEFAULT_FOLDER
render()
void refresh().then(() => {
  if (location.pathname !== pathForFolder(state.current)) history.replaceState(null, '', pathForFolder(state.current))
  render()
})
