// What names a file on this computer in the address bar and in the stores that remember pages. Pure.
// `parseOmniboxInput` and `sanitizeDirectUrl` keep refusing `file:` for every input that is not a person
// choosing a file (settings, a page's link, an extension); only the callers that are, take these.
import { pathToFileURL } from 'node:url'
import { localFileKey } from '../../broker/policy/origin.js'
import { sanitizeDirectUrl } from './omnibox.js'

const POSIX_ABSOLUTE = /^\/(?!\/)/
const WINDOWS_DRIVE = /^[A-Za-z]:[\\/]/
const LINE_BREAK = /[\r\n]/

/** The `file:` URL of a local document, normalised, or null when `value` is not one (a host, a share, over the key cap). */
export function sanitizeLocalFileUrl (value: string): string | null {
  const trimmed = value.trim()
  if (!/^file:/i.test(trimmed) || LINE_BREAK.test(trimmed)) return null
  try {
    const url = new URL(trimmed)
    return localFileKey(url.href) === null ? null : url.href
  } catch {
    return null
  }
}

/** What a stored address may be: a web address or a local file's. */
export function sanitizeBrowserUrl (value: string): string | null {
  return sanitizeDirectUrl(value) ?? sanitizeLocalFileUrl(value)
}

/** The local file the address bar's text names: a `file:` URL or an absolute path (a drive path on Windows only), whole with its query and fragment. */
export function parseLocalFileInput (text: string, platform: NodeJS.Platform = process.platform): string | null {
  const trimmed = text.trim()
  if (trimmed === '' || LINE_BREAK.test(trimmed)) return null
  if (/^file:/i.test(trimmed)) return sanitizeLocalFileUrl(trimmed)
  const windows = platform === 'win32'
  if (!(POSIX_ABSOLUTE.test(trimmed) || (windows && WINDOWS_DRIVE.test(trimmed)))) return null
  try {
    return sanitizeLocalFileUrl(pathToFileURL(trimmed, { windows }).href)
  } catch {
    return null
  }
}
