// Asks where to save, then writes the bookmarks file there. The path comes from the dialog, never from a page.
import { app } from 'electron'
import type { BaseWindow } from 'electron'
import { join } from 'node:path'
import { writeFileAtomicAsync } from '../../broker/adapters/atomic-write.js'
import { pickSaveFile } from '../shell/file-dialogs.js'
import type { BookmarkTreeInput } from './bookmark-types.js'
import { exportBookmarksHtml } from './bookmarks-html-export.js'

export type ExportOutcome = 'saved' | 'cancelled' | 'write'

export const exportFileName = (now: Date): string => `bookmarks-${now.toISOString().slice(0, 10)}.html`

export async function exportBookmarksToFile (window: BaseWindow | undefined, tree: Record<'bar' | 'other', BookmarkTreeInput[]>, now: Date = new Date()): Promise<ExportOutcome> {
  const path = await pickSaveFile(window, {
    defaultPath: join(app.getPath('downloads'), exportFileName(now)),
    filters: [{ name: 'HTML', extensions: ['html'] }]
  })
  if (path === undefined) return 'cancelled'
  try {
    await writeFileAtomicAsync(path, exportBookmarksHtml(tree))
    return 'saved'
  } catch {
    return 'write'
  }
}
