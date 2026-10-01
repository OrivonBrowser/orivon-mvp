// The decisions behind a download that need no Electron: what a name may be, where a file goes when its
// name is taken, and what a list of downloads adds up to.
import { randomBytes } from 'node:crypto'
import { join } from 'node:path'
import type { DownloadEntry, DownloadSummary } from './download-types.js'

/** What a file name is cut to, in UTF-8 bytes: file systems count bytes (255 on ext4, btrfs and xfs), not characters,
 * and this leaves room for a number or a random suffix after the stem. */
const MAX_NAME_BYTES = 200
const MAX_EXTENSION_BYTES = 20
const FALLBACK_NAME = 'download'
const RESERVED_WINDOWS_NAME = /^(con|prn|aux|nul|conin\$|conout\$|com[1-9\u00b9\u00b2\u00b3]|lpt[1-9\u00b9\u00b2\u00b3])(\..*)?$/i
/** Control characters (C0 and C1), the bidirectional marks, overrides and isolates that make `cod.exe` read as `exe.doc`,
 * zero-width characters and the byte order mark that hide part of a name, and what Windows refuses in a name. */
const FORBIDDEN_CHARACTERS = /[\u0000-\u001f\u007f-\u009f\u061c\u200b-\u200f\u202a-\u202e\u2066-\u2069\ufeff<>:"|?*]/gu
const byteLength = (text: string): number => Buffer.byteLength(text, 'utf8')
/** `.tar.gz` and its kin keep their first part when a name is numbered: `a (1).tar.gz`, not `a.tar (1).gz`. */
const EXTENSION = /(\.tar)?\.[^./\\]+$/

/** A name a server or a page suggested, made safe to join to a folder: no directory part, no characters a file
 * system refuses, no hidden or Windows-reserved names, cut to a length every file system takes. Never empty. */
export function safeFileName (suggested: string, fallback: string = FALLBACK_NAME): string {
  const base = suggested.split(/[\\/]/u).filter((part) => part !== '').at(-1) ?? ''
  let name = base.replace(FORBIDDEN_CHARACTERS, '_').replace(/^[. ]+/u, '').replace(/[. ]+$/u, '')
  if (name === '') return fallback
  if (RESERVED_WINDOWS_NAME.test(name)) name = `_${name}`
  if (byteLength(name) > MAX_NAME_BYTES) name = truncate(name)
  return name
}

/** Cuts to the byte limit, keeping a short extension whole and never splitting a character. */
function truncate (name: string): string {
  const extension = EXTENSION.exec(name)?.[0] ?? ''
  const kept = extension.length > 0 && byteLength(extension) <= MAX_EXTENSION_BYTES ? extension : ''
  const room = MAX_NAME_BYTES - byteLength(kept)
  let used = 0
  let stem = ''
  for (const char of name.slice(0, name.length - kept.length)) {
    used += byteLength(char)
    if (used > room) break
    stem += char
  }
  return `${stem.replace(/[. ]+$/u, '')}${kept}`
}

/** How many numbers are tried before a random suffix takes over: a folder full of one name must not cost a stat per copy. */
const MAX_NUMBERED = 100

/** How much of an address is stored. A page chooses the address of a download (a `data:` URL may run to megabytes), and
 * the list is written whole and sent to the Downloads page, so an address is kept short. */
export const MAX_ADDRESS_LENGTH = 2048
const MAX_TEXT_LENGTH = 255

/** An address cut for storage: only the scheme of a `data:`, `blob:` or `filesystem:` URL, which carry content and not a
 * place, and the first 2,048 characters of any other. A cut address is no longer the one that was asked for. */
export function storedAddress (address: string): string {
  const inline = /^(data|blob|filesystem):/iu.exec(address)
  if (inline !== null) return inline[0].toLowerCase()
  return address.length > MAX_ADDRESS_LENGTH ? address.slice(0, MAX_ADDRESS_LENGTH) : address
}

/** Text a page or a server chose (a content type), cut to a length no real value reaches. */
export function boundedText (text: string): string {
  return text.length > MAX_TEXT_LENGTH ? text.slice(0, MAX_TEXT_LENGTH) : text
}

const randomSuffix = (): string => randomBytes(4).toString('hex')

/** `dir/name`, or `dir/stem (1).ext`, `dir/stem (2).ext`, ... for the first that `exists` does not report; past a
 * hundred copies a random suffix, which is also checked, so a name that is taken is never returned. */
export function uniquePath (dir: string, name: string, exists: (path: string) => boolean, suffix: () => string = randomSuffix): string {
  const first = join(dir, name)
  if (!exists(first)) return first
  const extension = EXTENSION.exec(name)?.[0] ?? ''
  const stem = name.slice(0, name.length - extension.length)
  for (let number = 1; number <= MAX_NUMBERED; number += 1) {
    const candidate = join(dir, `${stem} (${String(number)})${extension}`)
    if (!exists(candidate)) return candidate
  }
  for (;;) {
    const candidate = join(dir, `${stem} (${suffix()})${extension}`)
    if (!exists(candidate)) return candidate
  }
}

export function isActive (entry: Pick<DownloadEntry, 'state'>): boolean {
  return entry.state === 'progressing' || entry.state === 'paused'
}

/** Not running and not waiting for an answer: safe to forget. */
export function isSettled (entry: Pick<DownloadEntry, 'state'>): boolean {
  return !isActive(entry) && entry.state !== 'held'
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
