// Save page as: a web page is written with its resources (a folder beside `.html`) or as one
// `.mhtml` file, by the extension typed; anything else the tab shows (an image, a PDF, plain text)
// is downloaded as the file it is. A path only ever comes from the save dialog.
import { join } from 'node:path'
import type { ShellWindow } from '../shell/window-registry.js'
import type { PageToolDeps } from './deps.js'
import { baseName, downloadName, formatFor, isSavableDocument, safeFileName } from './file-names.js'
import type { SaveFormat } from './file-names.js'
import { showToast } from './toast.js'
import { TimedOut, withTimeout } from './with-timeout.js'

interface DownloadItemLike {
  setSavePath: (path: string) => void
  once: (event: 'done', listener: (event: unknown, state: string) => void) => unknown
}

type WillDownload = (event: unknown, item: DownloadItemLike, source: { id: number }) => void

export interface SaveContents {
  readonly id: number
  getURL: () => string
  isCrashed: () => boolean
  savePage: (path: string, format: SaveFormat) => Promise<void>
  downloadURL: (url: string) => void
  readonly session: {
    on: (event: 'will-download', listener: WillDownload) => unknown
    removeListener: (event: 'will-download', listener: WillDownload) => unknown
  }
  readonly mainFrame: { executeJavaScript: (code: string) => Promise<unknown> }
}

const SAVE_MS = 60_000
const TYPE_MS = 2000
const DOWNLOAD_START_MS = 10_000

const FILTERS = [
  { name: 'Web page, complete (*.html)', extensions: ['html', 'htm'] },
  { name: 'Web page, single file (*.mhtml)', extensions: ['mhtml'] }
]

/** The page's own content type, or undefined when it cannot say (a dead or still loading page). */
async function contentTypeOf (wc: SaveContents): Promise<string | undefined> {
  try {
    const type = await withTimeout(wc.mainFrame.executeJavaScript('document.contentType'), TYPE_MS, 'the page')
    return typeof type === 'string' ? type : undefined
  } catch {
    return undefined
  }
}

/** Downloads `url` into `path` through the tab's session; false when no download starts or it does not complete. */
async function downloadTo (wc: SaveContents, url: string, path: string): Promise<boolean> {
  return await new Promise<boolean>((resolve) => {
    const startTimer = setTimeout(() => { wc.session.removeListener('will-download', onItem); resolve(false) }, DOWNLOAD_START_MS)
    function onItem (_event: unknown, item: DownloadItemLike, source: { id: number }): void {
      if (source.id !== wc.id) return
      clearTimeout(startTimer)
      wc.session.removeListener('will-download', onItem)
      // Synchronously: a download given its path later never completes.
      item.setSavePath(path)
      item.once('done', (_done, state) => { resolve(state === 'completed') })
    }
    wc.session.on('will-download', onItem)
    try {
      wc.downloadURL(url)
    } catch {
      clearTimeout(startTimer)
      wc.session.removeListener('will-download', onItem)
      resolve(false)
    }
  })
}

export async function savePage (window: ShellWindow, page: { wc: SaveContents, title: string, url: string }, deps: PageToolDeps): Promise<void> {
  const { wc, url } = page
  if (!/^https?:/i.test(url)) { showToast(window, 'cannotSave'); return }
  if (wc.isCrashed()) { showToast(window, 'saveFailed'); return }
  const document = isSavableDocument(url, await contentTypeOf(wc))
  const path = await deps.pickSave(window.window, document
    ? { title: 'Save page as', defaultPath: join(deps.downloadsDir(), safeFileName(page.title, 'html')), filters: FILTERS }
    : { title: 'Save as', defaultPath: join(deps.downloadsDir(), downloadName(url)) })
  if (path === undefined) return
  try {
    let saved = true
    if (document) await withTimeout(wc.savePage(path, formatFor(path)), SAVE_MS, 'the page')
    else saved = await downloadTo(wc, url, path)
    showToast(window, saved ? 'saved' : 'saveFailed', saved ? baseName(path) : undefined, saved ? path : undefined)
  } catch (error) {
    if (!(error instanceof TimedOut)) console.error('[page-tools] saving the page failed', error)
    showToast(window, 'saveFailed')
  }
}
