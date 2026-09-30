// The decisions behind a download that need no Electron: what a name may be, where a file goes when its
// name is taken, and what a list of downloads adds up to.
import { join } from 'node:path'
import type { DownloadEntry, DownloadSummary } from './download-types.js'

/** What a file name is cut to. Most file systems allow 255 bytes; this leaves room for " (99)" and a multi-byte name. */
const MAX_NAME_LENGTH = 200
const MAX_EXTENSION_LENGTH = 20
const FALLBACK_NAME = 'download'
const RESERVED_WINDOWS_NAME = /^(con|prn|aux|nul|com[1-9]|lpt[1-9])(\..*)?$/i
/** Control characters, the bidirectional overrides and isolates that make `cod.exe` read as `exe.doc`, and what Windows refuses in a name. */
const FORBIDDEN_CHARACTERS = /[\u0000-\u001f\u007f‎‏‪-‮⁦-⁩<>:"|?*]/gu
/** `.tar.gz` and its kin keep their first part when a name is numbered: `a (1).tar.gz`, not `a.tar (1).gz`. */
const EXTENSION = /(\.tar)?\.[^./\\]+$/

/** A name a server or a page suggested, made safe to join to a folder: no directory part, no characters a file
 * system refuses, no hidden or Windows-reserved names, cut to a length every file system takes. Never empty. */
export function safeFileName (suggested: string, fallback: string = FALLBACK_NAME): string {
  const base = suggested.split(/[\\/]/u).filter((part) => part !== '').at(-1) ?? ''
  let name = base.replace(FORBIDDEN_CHARACTERS, '_').replace(/^[. ]+/u, '').replace(/[. ]+$/u, '')
  if (name === '') return fallback
  if (RESERVED_WINDOWS_NAME.test(name)) name = `_${name}`
  if (name.length > MAX_NAME_LENGTH) name = truncate(name)
  return name
}

/** Cuts to the limit, keeping a short extension whole and never splitting a surrogate pair. */
function truncate (name: string): string {
  const extension = EXTENSION.exec(name)?.[0] ?? ''
  const kept = extension.length > 0 && extension.length <= MAX_EXTENSION_LENGTH ? extension : ''
  const stem = Array.from(name.slice(0, name.length - kept.length)).reduce((cut, char) => (cut.length + char.length <= MAX_NAME_LENGTH - kept.length ? cut + char : cut), '')
  return `${stem}${kept}`
}

const MAX_NUMBERED = 10_000

/** `dir/name`, or `dir/stem (1).ext`, `dir/stem (2).ext`, ... for the first that `exists` does not report. */
export function uniquePath (dir: string, name: string, exists: (path: string) => boolean): string {
  const first = join(dir, name)
  if (!exists(first)) return first
  const extension = EXTENSION.exec(name)?.[0] ?? ''
  const stem = name.slice(0, name.length - extension.length)
  for (let number = 1; number <= MAX_NUMBERED; number += 1) {
    const candidate = join(dir, `${stem} (${String(number)})${extension}`)
    if (!exists(candidate)) return candidate
  }
  return join(dir, `${stem} (${String(MAX_NUMBERED + 1)})${extension}`)
}

export function isActive (entry: Pick<DownloadEntry, 'state'>): boolean {
  return entry.state === 'progressing' || entry.state === 'paused'
}

export function summarise (entries: readonly DownloadEntry[]): DownloadSummary {
  let active = 0
  let received = 0
  let total = 0
  for (const entry of entries) {
    if (!isActive(entry)) continue
    active += 1
    if (entry.total > 0) {
      received += Math.min(entry.received, entry.total)
      total += entry.total
    }
  }
  return { active, fraction: total > 0 ? received / total : null, any: entries.length > 0 }
}
