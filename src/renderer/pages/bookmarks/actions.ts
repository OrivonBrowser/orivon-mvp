// What a person can do to rows: open, rename, file elsewhere, delete and take it back, copy, save the file. Each call
// asks main, then has the page fetch again; the page draws.
import { openRowMenu } from '../shared/row-menu.js'
import type { MenuItem } from '../shared/row-menu.js'
import { nudgeIndex } from './drop-target.js'
import { openMoveSheet } from './move-sheet.js'
import { refresh } from './load.js'
import { listed, listedIds, request, rowById, state } from './state.js'
import type { Row } from './state.js'
import { showToast } from './toast.js'
import { titleOf } from './view-list.js'

export interface Shell {
  /** Draws the page from the state; `focus`: the focus goes to the row the keys act on. */
  render: (focus?: boolean) => void
  /** Go to a folder, optionally with a row chosen in it. */
  go: (id: string, choose?: string[]) => Promise<void>
  clearSearch: () => Promise<void>
  /** Called when an edit, a dialog or a drag ends, so a change that arrived meanwhile is shown. */
  settle: () => void
  returnFocus: () => void
}

const MAX_DELETE_TEXT = 60

const clip = (text: string): string => text.length > MAX_DELETE_TEXT ? `${text.slice(0, MAX_DELETE_TEXT - 1)}…` : text
const plural = (count: number, word: string): string => `${count.toLocaleString()} ${word}${count === 1 ? '' : 's'}`

export function createActions (shell: Shell) {
  /** The rows an action applies to: the chosen ones when `row` is among them, else `row` alone. */
  const targets = (row: Row | undefined): Row[] => {
    if (row !== undefined && !state.selected.has(row.id)) return [row]
    const chosen = listed().filter((candidate) => state.selected.has(candidate.id))
    return chosen.length > 0 ? chosen : row === undefined ? [] : [row]
  }

  async function reload (choose?: string[]): Promise<void> {
    await refresh()
    if (choose !== undefined) {
      state.selected = new Set(choose)
      state.anchor = choose[0] ?? null
      state.focusId = choose[0] ?? null
    }
    shell.render(choose !== undefined)
  }

  async function open (row: Row, how: 'tab' | 'background' | 'window' | 'private'): Promise<void> {
    if (row.kind === 'folder') {
      if (how === 'tab') await shell.go(row.id)
      return
    }
    await request({ type: 'open', id: row.id, disposition: how })
  }

  async function openAll (row: Row): Promise<void> {
    await request({ type: 'openAll', id: row.id })
  }

  function rename (row: Row): void {
    state.editing = { id: row.id, fresh: false }
    state.focusId = row.id
    const at = listedIds().indexOf(row.id)
    state.shown = Math.max(state.shown, at + 1)
    shell.render()
  }

  async function newFolder (): Promise<void> {
    if (state.query !== '') await shell.clearSearch()
    const made = await request<{ ok: boolean, id?: string, reason?: string }>({ type: 'addFolder', parent: state.current, index: 0, title: 'New folder' })
    if (made?.ok !== true || made.id === undefined) { showToast('This folder cannot hold another folder.'); return }
    await refresh()
    state.selected = new Set([made.id])
    state.anchor = made.id
    state.focusId = made.id
    state.editing = { id: made.id, fresh: true }
    shell.render()
  }

  async function remove (rows: readonly Row[]): Promise<void> {
    if (rows.length === 0) return
    const ids = rows.map((row) => row.id)
    const next = listedIds().filter((id) => !ids.includes(id))
    const at = Math.min(listedIds().findIndex((id) => ids.includes(id)), Math.max(0, next.length - 1))
    const reply = await request<{ removed: number, items: number, undo: string | null }>({ type: 'remove', ids })
    if (reply === undefined || reply.removed === 0) return
    state.selected = new Set()
    state.anchor = null
    state.focusId = next[at] ?? null
    const text = reply.items === 1 ? `Deleted "${clip(titleOf(rows[0] as Row))}"` : `Deleted ${plural(reply.items, 'item')}`
    const token = reply.undo
    showToast(text, token === null ? undefined : { label: 'Undo', run: () => { void undo(token) } })
    await refresh()
    shell.render(true)
  }

  async function undo (token: string): Promise<void> {
    const reply = await request<{ ok: boolean, ids?: string[] }>({ type: 'undo', token })
    if (reply?.ok !== true) { showToast('That delete can no longer be undone.'); return }
    await reload(reply.ids ?? [])
  }

  /** `parent` null: the folder shown. `index` is a position in it as it stands. */
  async function move (ids: readonly string[], parent: string | null, index?: number): Promise<void> {
    const reply = await request<{ ok: boolean }>({ type: 'move', ids, parent: parent ?? state.current, ...(index === undefined ? {} : { index }) })
    if (reply?.ok !== true) { showToast('That cannot be moved there.'); return }
    await reload(state.selected.size > 0 ? undefined : [...ids])
  }

  async function nudge (direction: 'up' | 'down', row: Row | undefined): Promise<void> {
    if (state.results !== null) return
    const ids = targets(row).map((target) => target.id)
    const index = nudgeIndex(listedIds(), new Set(ids), direction)
    if (index === null) return
    await move(ids, null, index)
    shell.render(true)
  }

  function moveTo (rows: readonly Row[], opener: HTMLElement | null): void {
    const first = rows[0]
    if (first === undefined) return
    const from = first.parent ?? state.current
    openMoveSheet({
      folders: state.folders,
      moving: rows.filter((row) => row.kind === 'folder').map((row) => row.id),
      initial: from,
      summary: rows.length === 1 ? titleOf(first) : plural(rows.length, 'item'),
      move: (parent) => { void move(rows.map((row) => row.id), parent).then(() => { shell.returnFocus(); shell.settle() }) },
      closed: () => { if (opener?.isConnected === true) opener.focus(); else shell.returnFocus(); shell.settle() }
    })
  }

  async function copy (rows: readonly Row[]): Promise<void> {
    await request({ type: 'copy', ids: rows.map((row) => row.id) })
  }

  async function exportFile (): Promise<void> {
    const reply = await request<{ ok: boolean, count?: number, reason?: string }>({ type: 'export' })
    if (reply?.ok === true) showToast(`Exported ${plural(reply.count ?? 0, 'bookmark')}.`)
    else if (reply?.reason === 'write') showToast('The file could not be saved.')
  }

  function rowMenu (row: Row, place: { x: number, y: number, alignRight: boolean }, opener: HTMLElement | null): void {
    const rows = targets(row)
    const items: MenuItem[] = []
    const edit = { label: row.kind === 'folder' ? 'Rename' : 'Edit', run: () => { rename(row) } }
    const tail: MenuItem[] = [
      { label: 'Move to…', run: () => { moveTo(rows, opener) } },
      { label: rows.length > 1 ? `Delete ${plural(rows.length, 'item')}` : 'Delete', danger: true, run: () => { void remove(rows) } }
    ]
    if (rows.length > 1) {
      items.push({ label: 'Copy links', run: () => { void copy(rows) } }, { label: '', run: () => {}, separator: true }, ...tail)
    } else if (row.kind === 'folder') {
      const pages = row.pages ?? 0
      if (pages > 0) items.push({ label: pages > 25 ? `Open all (25 of ${String(pages)})` : `Open all (${String(pages)})`, run: () => { void openAll(row) } }, { label: '', run: () => {}, separator: true })
      items.push(edit, ...tail)
    } else {
      items.push({ label: 'Open in new tab', run: () => { void open(row, 'tab') } }, { label: 'Open in new window', run: () => { void open(row, 'window') } })
      if (!state.isPrivate) items.push({ label: 'Open in private window', run: () => { void open(row, 'private') } })
      if (state.results !== null && row.parent !== undefined) items.push({ label: 'Show in folder', run: () => { void shell.go(row.parent as string, [row.id]) } })
      items.push({ label: '', run: () => {}, separator: true }, edit, { label: 'Copy link', run: () => { void copy([row]) } }, ...tail)
    }
    openRowMenu(items, place, () => { if (opener?.isConnected === true) opener.focus(); else shell.returnFocus() }, `Actions for ${titleOf(row)}`)
  }

  return { targets, open, rename, newFolder, remove, undo, move, nudge, moveTo, copy, exportFile, rowMenu, reload, rowById }
}

export type Actions = ReturnType<typeof createActions>
