// Saving the sheet's code as a picture. The page sends the PNG it drew; main checks what it got, builds the file
// name itself and never overwrites a file that is there.
import { uniquePath } from '../downloads/download-model.js'

/** A 232px code drawn at twice that stays far below this; anything bigger is not what the sheet sends. */
export const MAX_PNG_BYTES = 200 * 1024
const PNG_SIGNATURE = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]
const MAX_NAME_HOST = 60
/** What base64 of a maximal PNG spells, with room for padding: a longer string is refused before it is decoded. */
const MAX_BASE64_LENGTH = Math.ceil(MAX_PNG_BYTES / 3) * 4

/** The bytes of `base64` when it is a PNG within the cap, otherwise undefined. */
export function pngFrom (base64: unknown): Uint8Array | undefined {
  if (typeof base64 !== 'string' || base64.length === 0 || base64.length > MAX_BASE64_LENGTH) return undefined
  if (!/^[A-Za-z0-9+/]+={0,2}$/.test(base64)) return undefined
  const bytes = Buffer.from(base64, 'base64')
  if (bytes.length > MAX_PNG_BYTES || bytes.length < PNG_SIGNATURE.length) return undefined
  return PNG_SIGNATURE.every((byte, index) => bytes[index] === byte) ? new Uint8Array(bytes) : undefined
}

/** `qr-<host>.png` with the host cut to letters, digits, dots and hyphens; `qr-page.png` when nothing is left. */
export function qrFileName (address: string): string {
  let host = ''
  try {
    host = new URL(address).hostname
    // An IPv6 literal reduces to a stray digit; a name that means nothing is better than one that misleads.
    if (host.includes(':')) host = ''
  } catch {
    host = ''
  }
  const safe = host.replace(/[^A-Za-z0-9.-]/g, '').replace(/^[.-]+/, '').slice(0, MAX_NAME_HOST)
  return `qr-${safe === '' ? 'page' : safe}.png`
}

export interface QrSaveDeps {
  downloadsDir: () => string
  exists: (path: string) => boolean
  writeFile: (path: string, data: Uint8Array) => Promise<void>
}

/** The path written, or undefined when the picture was refused or the write failed. */
export async function saveQrPng (deps: QrSaveDeps, address: string, base64: unknown): Promise<string | undefined> {
  const png = pngFrom(base64)
  if (png === undefined) return undefined
  const path = uniquePath(deps.downloadsDir(), qrFileName(address), deps.exists)
  try {
    await deps.writeFile(path, png)
    return path
  } catch {
    return undefined
  }
}
