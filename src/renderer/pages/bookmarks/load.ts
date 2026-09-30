// Fetching what the page shows into the state. No drawing here: the caller draws once a load has resolved, and a
// load that a newer one overtook is dropped.
import { DEFAULT_FOLDER } from './router.js'
import { request, rowsFrom, state } from './state.js'
import type { FolderInfo } from './folder-tree.js'
import type { Crumb, Row } from './state.js'

interface TreeReply { readonly private: boolean, readonly importAvailable: boolean, readonly folders: FolderInfo[] }
interface FolderReply { readonly path: Crumb[], readonly rows: Array<Record<string, unknown>>, readonly icons: string[] }
interface SearchReply { readonly rows: Array<Record<string, unknown>>, readonly more: boolean, readonly icons: string[] }

let generation = 0

/** The tree, the folder the page is in and the search, fetched together. A folder that is gone falls back to the bar. */
export async function refresh (): Promise<void> {
  const mine = ++generation
  const [tree, folder, search] = await Promise.all([
    request<TreeReply>({ type: 'tree' }),
    request<FolderReply>({ type: 'children', id: state.current }),
    state.query === '' ? Promise.resolve(undefined) : request<SearchReply>({ type: 'search', text: state.query })
  ])
  if (mine !== generation || tree === undefined) return
  state.isPrivate = tree.private
  state.importAvailable = tree.importAvailable
  state.folders = tree.folders
  let shown = folder
  if (shown === undefined) {
    state.current = DEFAULT_FOLDER
    shown = await request<FolderReply>({ type: 'children', id: DEFAULT_FOLDER })
    if (mine !== generation) return
  }
  if (shown !== undefined) {
    state.crumbs = shown.path
    state.rows = rowsFrom(shown.rows, shown.icons)
    for (const crumb of shown.path.slice(0, -1)) state.expanded.add(crumb.id)
  }
  state.results = search === undefined ? null : rowsFrom(search.rows, search.icons)
  state.moreResults = search?.more ?? false
  state.loaded = true
  const present = new Set((state.results ?? state.rows).map((row: Row) => row.id))
  state.selected = new Set([...state.selected].filter((id) => present.has(id)))
  if (state.anchor !== null && !present.has(state.anchor)) state.anchor = null
  if (state.focusId !== null && !present.has(state.focusId)) state.focusId = null
  if (state.treeFocus === null || !state.folders.some((folder) => folder.id === state.treeFocus)) state.treeFocus = state.current
}
