// The options of a folder picker: every folder of the bar and of Other bookmarks, indented two non-breaking spaces
// per level (a native option cannot nest), and optionally a last choice that makes a new one.
import type { FolderChoice } from '../../../main/shell/bookmark-bubble/edit-model.js'
import { h } from '../../pages/shared/dom.js'

/** Not an id the store can make: ids are hex, and the roots are named. */
export const NEW_FOLDER = '__new__'

export const INDENT = '  '

export function folderOptions (folders: readonly FolderChoice[], withNew: boolean): HTMLOptionElement[] {
  const options = folders.map((folder) => h('option', { value: folder.id, textContent: INDENT.repeat(folder.depth) + folder.title }))
  return withNew ? [...options, h('option', { value: NEW_FOLDER, textContent: 'New folder…' })] : options
}
