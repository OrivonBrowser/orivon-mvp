// File names for what the page tools write. Pure: a title comes from a page, so nothing in it may
// reach a path as a separator, a control character or a name the platform reserves.

const MAX_STEM = 120
/** Characters no common file system accepts in a name, plus every control character. */
const UNSAFE = /[\u0000-\u001f\u007f<>:"/\\|?*]+/g
/** Names Windows refuses whatever their extension. */
const RESERVED = /^(con|prn|aux|nul|com[1-9]|lpt[1-9])$/i

/** `title` as the stem of a file named `<stem>.<ext>`; `page` when nothing usable is left. */
export function safeFileName (title: string, ext: string): string {
  const cleaned = title.replace(UNSAFE, ' ').replace(/\s+/g, ' ').trim().replace(/^[.\s]+/, '').replace(/[. ]+$/, '')
  const cut = [...cleaned].slice(0, MAX_STEM).join('').trim()
  const stem = cut.length === 0 || RESERVED.test(cut) ? 'page' : cut
  return `${stem}.${ext}`
}

const two = (n: number): string => String(n).padStart(2, '0')

/** `Screenshot 2026-09-30 at 14.05.09.png`, in the local time of `date`. */
export function screenshotName (date: Date): string {
  const day = `${String(date.getFullYear())}-${two(date.getMonth() + 1)}-${two(date.getDate())}`
  const time = `${two(date.getHours())}.${two(date.getMinutes())}.${two(date.getSeconds())}`
  return `Screenshot ${day} at ${time}.png`
}

export type SaveFormat = 'HTMLComplete' | 'MHTML'

/** The format a typed file name asks for: `.mhtml` and `.mht` are a single file, anything else is a page with its resources. */
export function formatFor (path: string): SaveFormat {
  return /\.mht(ml)?$/i.test(path) ? 'MHTML' : 'HTMLComplete'
}

/** The last segment of a path in either separator style, for a toast. */
export function baseName (path: string): string {
  return path.split(/[\\/]/).pop() ?? path
}

const DOCUMENT_TYPES = new Set(['text/html', 'application/xhtml+xml'])
const DOCUMENT_EXTENSIONS = new Set(['', 'html', 'htm', 'xhtml', 'php', 'asp', 'aspx', 'jsp'])

/** Whether the page is a web page that can be saved with its resources, from its content type when the page answered and its address otherwise. */
export function isSavableDocument (url: string, contentType: string | undefined): boolean {
  if (contentType !== undefined && contentType !== '') return DOCUMENT_TYPES.has(contentType.split(';')[0]?.trim().toLowerCase() ?? '')
  try {
    const last = new URL(url).pathname.split('/').pop() ?? ''
    const ext = last.includes('.') ? last.split('.').pop()?.toLowerCase() ?? '' : ''
    return DOCUMENT_EXTENSIONS.has(ext)
  } catch {
    return false
  }
}

/** What an extension from an address may be: a few letters and digits. The page chooses the address, so anything
 * else (a separator, a control character, a long run) is not carried into a path. */
const SAFE_EXTENSION = /^[a-z0-9]{1,16}$/i

/** A name for a non-page download, taken from the address's last segment. */
export function downloadName (url: string): string {
  try {
    const last = decodeURIComponent(new URL(url).pathname.split('/').pop() ?? '')
    const ext = last.includes('.') ? last.split('.').pop() ?? '' : ''
    return safeFileName(last.replace(/\.[^.]*$/, ''), SAFE_EXTENSION.test(ext) ? ext : 'bin')
  } catch {
    return 'download.bin'
  }
}

/** `path` with `ext` added when the person typed a name with none: a save dialog on some platforms adds nothing. */
export function withExtension (path: string, ext: string): string {
  const name = baseName(path)
  return name.includes('.') && !name.endsWith('.') ? path : `${path.replace(/\.+$/, '')}.${ext}`
}
