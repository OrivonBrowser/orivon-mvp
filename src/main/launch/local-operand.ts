// A command-line operand that names a file on this computer: a `file:` URI (what a desktop entry's `%U` passes) or
// a path that exists, read against the directory the browser was started from. Nothing here opens anything.
import { statSync } from 'node:fs'
import { posix, win32 } from 'node:path'
import { pathToFileURL } from 'node:url'
import { sanitizeLocalFileUrl } from '../browsing/local-file-input.js'
import { urlsFromArgv } from './launch-context.js'

export type PathKind = 'file' | 'directory' | undefined

/** What the disk holds at `path`: a file, a directory, or nothing the browser can show. */
export function pathKind (path: string): PathKind {
  try {
    const stat = statSync(path)
    return stat.isDirectory() ? 'directory' : stat.isFile() ? 'file' : undefined
  } catch {
    return undefined
  }
}

/** Two or more letters then a colon: a scheme. One letter is a Windows drive. */
const SCHEME = /^[A-Za-z][A-Za-z0-9+.-]+:/

/** A Windows path on a drive. A network share and the device namespaces are no local file, and statting one is already a round trip to that host. */
const DRIVE_PATH = /^[A-Za-z]:[\\/]/

/** The `file:` URL `operand` names, or null: a URI with a host, a path that is not there and every other scheme are not files. */
export function localOperandUrl (operand: string, cwd: string, kindOf: (path: string) => PathKind = pathKind, platform: NodeJS.Platform = process.platform): string | null {
  if (/^file:/i.test(operand)) return sanitizeLocalFileUrl(operand)
  if (SCHEME.test(operand) || operand === '') return null
  const path = platform === 'win32' ? win32 : posix
  const absolute = path.resolve(cwd, operand)
  if (platform === 'win32' && !DRIVE_PATH.test(absolute)) return null
  if (kindOf(absolute) === undefined) return null
  return sanitizeLocalFileUrl(pathToFileURL(absolute, { windows: platform === 'win32' }).href)
}

/** The http(s) addresses and local files among `operands`, in their order, at most `limit`. */
export function addressesFromOperands (operands: readonly string[], cwd: string, kindOf: (path: string) => PathKind = pathKind, platform: NodeJS.Platform = process.platform, limit = 8): string[] {
  const found: string[] = []
  for (const operand of operands) {
    if (found.length >= limit) break
    const web = urlsFromArgv([operand], 1)[0]
    const address = web ?? localOperandUrl(operand, cwd, kindOf, platform)
    if (address !== null && address !== undefined) found.push(address)
  }
  return found
}
