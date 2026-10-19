// The page a UnixFS directory without an index.html is answered with: one row
// per entry, built only from names and sizes a verified directory block gave.
// Names are attacker-controlled bytes, so every one is escaped for the text
// and percent-encoded for the link, and the page forbids script and any load.

export type EntryKind = 'folder' | 'file' | 'unknown'

export interface ListedEntry {
  readonly name: string
  readonly kind: EntryKind
  readonly size: bigint
  /** Read from the entry's own node; false when it is only the size its link names. */
  readonly exact: boolean
}

export interface DirectoryListing {
  /** The directory's decoded path segments; empty for the root. */
  readonly segments: readonly string[]
  readonly entries: readonly ListedEntry[]
  /** How many entries the directory has beyond those listed; undefined when that is not known (a sharded directory is not counted). */
  readonly more: number | undefined
  readonly truncated: boolean
}

const PAGE_CSP = "default-src 'none'; style-src 'unsafe-inline'"
const UNITS = ['kB', 'MB', 'GB', 'TB', 'PB']

function escapeHtml (text: string): string {
  return text.replace(/[&<>"']/g, (c) => `&#${String(c.charCodeAt(0))};`)
}

/** Control characters and bidirectional overrides can make a name read as another, so they are shown as code points. */
const UNSAFE_TO_SHOW = /[\u0000-\u001f\u007f-\u009f‎‏‪-‮⁦-⁩]/g

function visible (name: string): string {
  return name.replace(UNSAFE_TO_SHOW, (c) => `[U+${c.charCodeAt(0).toString(16).toUpperCase().padStart(4, '0')}]`)
}

/** Decimal units, one decimal place from a thousand bytes up. */
export function formatSize (bytes: bigint): string {
  if (bytes < 1000n) return `${bytes.toString()} B`
  let value = Number(bytes)
  let unit = -1
  while (value >= 1000 && unit < UNITS.length - 1) {
    value /= 1000
    unit++
  }
  return `${value.toFixed(1)} ${UNITS[unit] ?? 'kB'}`
}

/** A name pathSegments would refuse can be shown but never followed. */
function followable (name: string): boolean {
  return name !== '' && name !== '.' && name !== '..' && !name.includes('/') && !name.includes('\0')
}

function row (entry: ListedEntry): string {
  const shown = escapeHtml(visible(entry.name)) + (entry.kind === 'folder' ? '/' : '')
  const name = followable(entry.name)
    ? `<a href="${escapeHtml(encodeURIComponent(entry.name))}${entry.kind === 'folder' ? '/' : ''}">${escapeHtml(visible(entry.name))}${entry.kind === 'folder' ? '/' : ''}</a>`
    : shown
  const kind = entry.kind === 'unknown' ? 'file or folder' : entry.kind
  const size = entry.kind === 'folder' ? '' : `${entry.exact ? '' : '~'}${formatSize(entry.size)}`
  return `<tr class="row"><td class="name">${name}</td><td class="kind">${kind}</td><td class="size">${size}</td></tr>`
}

function compareNames (a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0
}

/** Folders first, then everything else; each by name. */
export function sortEntries (entries: readonly ListedEntry[]): ListedEntry[] {
  return [...entries].sort((a, b) => (Number(b.kind === 'folder') - Number(a.kind === 'folder')) || compareNames(a.name, b.name))
}

export function renderDirectoryPage (listing: DirectoryListing): Uint8Array {
  const path = `/${listing.segments.map((s) => `${s}/`).join('')}`
  const title = `Index of ${visible(path)}`
  const parent = listing.segments.length === 0 ? '' : '<tr class="up"><td class="name"><a href="../">../</a></td><td class="kind">folder</td><td class="size"></td></tr>'
  const rows = sortEntries(listing.entries).map(row).join('')
  const approximate = listing.entries.some((e) => e.kind !== 'folder' && !e.exact)
  const empty = listing.entries.length === 0 ? '<p>This folder is empty.</p>' : ''
  const more = listing.truncated
    ? `<p class="note">${listing.more === undefined ? 'This folder has more entries than are shown.' : `and ${String(listing.more)} more entries are not shown.`}</p>`
    : ''
  const note = approximate ? '<p class="note">A size with ~ is approximate: it is the size the folder gives for that entry, which Orivon did not read from the entry itself.</p>' : ''
  const html = `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta http-equiv="Content-Security-Policy" content="${PAGE_CSP}"><meta name="color-scheme" content="light dark"><title>${escapeHtml(title)}</title>
<style>body{font:15px/1.5 system-ui,sans-serif;max-width:60rem;margin:3rem auto;padding:0 1rem}h1{font-size:1.4rem;word-break:break-all}table{border-collapse:collapse;width:100%}td{padding:.25rem .75rem .25rem 0;border-bottom:1px solid rgba(128,128,128,.25)}.name{word-break:break-all}.kind,.size{white-space:nowrap;opacity:.75}.size{text-align:right;padding-right:0}.note{opacity:.7;font-size:13px}a{color:inherit}</style></head>
<body><h1>${escapeHtml(title)}</h1>${empty}<table><tbody>${parent}${rows}</tbody></table>${more}${note}</body></html>
`
  return new TextEncoder().encode(html)
}
