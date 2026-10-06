// The page shown for a folder opened from this computer: Chromium cannot show one through the handler, so the
// handler writes it. Names are file names and so are not to be trusted: each is escaped as text and encoded as an address,
// and the page carries no script and, with the policy `file-handler.ts` sends, can run none.
import { readdir, stat } from 'node:fs/promises'
import { join } from 'node:path'

export interface DirectoryEntry {
  readonly name: string
  readonly isDirectory: boolean
}

/** The most entries one listing shows; a folder holding more says how many were left out. */
export const MAX_LISTED_ENTRIES = 5000

const ESCAPES: Record<string, string> = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }
const escapeHtml = (text: string): string => text.replace(/[&<>"']/g, (char) => ESCAPES[char] ?? char)

/** The entries of the folder at `path`, or undefined when `path` is not a folder (a file, nothing there, or not readable). A link to a folder counts as one. */
export async function readDirectory (path: string): Promise<DirectoryEntry[] | undefined> {
  try {
    if (!(await stat(path)).isDirectory()) return undefined
    const found = await readdir(path, { withFileTypes: true })
    return await Promise.all(found.map(async (entry) => ({
      name: entry.name,
      isDirectory: entry.isDirectory() || (entry.isSymbolicLink() && await stat(join(path, entry.name)).then((target) => target.isDirectory(), () => false))
    })))
  } catch {
    return undefined
  }
}

function byFoldersThenName (a: DirectoryEntry, b: DirectoryEntry): number {
  if (a.isDirectory !== b.isDirectory) return a.isDirectory ? -1 : 1
  return a.name.localeCompare(b.name, undefined, { numeric: true, sensitivity: 'base' }) || (a.name < b.name ? -1 : a.name > b.name ? 1 : 0)
}

const STYLE = 'body{font:15px system-ui,sans-serif;margin:24px auto;max-width:56rem;padding:0 16px;color:#1b1b1f;background:#fff}' +
  '@media(prefers-color-scheme:dark){body{color:#e6e6ea;background:#1b1b1f}a{color:#9ab8ff}}' +
  'h1{font-size:1.15rem;word-break:break-all}ul{list-style:none;padding:0}li{padding:3px 0;word-break:break-all}.note{opacity:.7}'

/** The listing of the folder at `folderUrl`, a `file:` address with an empty host, with `entries` in it. */
export function renderDirectoryListing (folderUrl: string, entries: readonly DirectoryEntry[]): string {
  const path = new URL(folderUrl).pathname
  const here = path.endsWith('/') ? path : `${path}/`
  const shownPath = decodeURIComponent(here)
  const sorted = [...entries].sort(byFoldersThenName)
  const shown = sorted.slice(0, MAX_LISTED_ENTRIES)
  const parentPath = here === '/' ? null : here.slice(0, here.lastIndexOf('/', here.length - 2) + 1)
  const rows = shown.map((entry) => {
    const href = `file://${here}${encodeURIComponent(entry.name)}${entry.isDirectory ? '/' : ''}`
    return `<li><a href="${escapeHtml(href)}">${escapeHtml(entry.name)}${entry.isDirectory ? '/' : ''}</a></li>`
  })
  const parent = parentPath === null ? '' : `<li><a href="${escapeHtml(`file://${parentPath}`)}">Parent folder</a></li>`
  const left = sorted.length - shown.length
  const notes = [
    entries.length === 0 ? '<p class="note">This folder is empty.</p>' : '',
    left > 0 ? `<p class="note">${String(left)} more not shown.</p>` : ''
  ].join('')
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><title>Index of ${escapeHtml(shownPath)}</title>` +
    `<meta name="viewport" content="width=device-width,initial-scale=1"><style>${STYLE}</style></head>` +
    `<body><h1>Index of ${escapeHtml(shownPath)}</h1><ul>${parent}${rows.join('')}</ul>${notes}</body></html>`
}
