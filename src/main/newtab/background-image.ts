// What a file must be to become the new tab's picture: one of five image formats, told by its leading bytes
// (a name proves nothing), and no larger than the cap.

/** The copy's name in a profile's folder. It has no extension: its format is read from its bytes. */
export const NEW_TAB_BACKGROUND_FILE = 'new-tab-background'

export type PictureType = 'png' | 'jpeg' | 'webp' | 'gif' | 'avif'

export const MAX_PICTURE_BYTES = 20 * 1024 * 1024

export const TOO_LARGE = 'That picture is larger than 20 MB. Choose a smaller one.'

const MIME: Readonly<Record<PictureType, string>> = {
  png: 'image/png',
  jpeg: 'image/jpeg',
  webp: 'image/webp',
  gif: 'image/gif',
  avif: 'image/avif'
}

const PNG_SIGNATURE = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]
const JPEG_SIGNATURE = [0xff, 0xd8, 0xff]
/** How far into an ISO media file the brands are looked for: the box that lists them is a few dozen bytes. */
const BRAND_WINDOW = 64

function startsWith (data: Uint8Array, signature: readonly number[], at = 0): boolean {
  return data.length >= at + signature.length && signature.every((byte, i) => data[at + i] === byte)
}

function text (data: Uint8Array, at: number, length: number): string {
  return String.fromCharCode(...data.subarray(at, at + length))
}

/** An AVIF file is an ISO media file whose `ftyp` box names `avif` or `avis`, as its main brand or among the compatible ones. */
function isAvif (data: Uint8Array): boolean {
  if (data.length < 16 || text(data, 4, 4) !== 'ftyp') return false
  const end = Math.min(data.length, BRAND_WINDOW)
  for (let at = 8; at + 4 <= end; at += 4) {
    // Bytes 12 to 15 are the minor version, not a brand.
    if (at === 12) continue
    const brand = text(data, at, 4)
    if (brand === 'avif' || brand === 'avis') return true
  }
  return false
}

/** The format `data` begins as, or null when it is none of the five. */
export function sniffPicture (data: Uint8Array): PictureType | null {
  if (startsWith(data, PNG_SIGNATURE)) return 'png'
  if (startsWith(data, JPEG_SIGNATURE)) return 'jpeg'
  if (data.length >= 12 && text(data, 0, 4) === 'RIFF' && text(data, 8, 4) === 'WEBP') return 'webp'
  if (data.length >= 6 && (text(data, 0, 6) === 'GIF87a' || text(data, 0, 6) === 'GIF89a')) return 'gif'
  if (isAvif(data)) return 'avif'
  return null
}

export type PictureCheck =
  | { readonly ok: true, readonly type: PictureType, readonly mime: string }
  | { readonly ok: false, readonly reason: string }

/** `size` is the file's size when `data` holds only its start. */
export function checkPicture (data: Uint8Array, size = data.length): PictureCheck {
  if (size > MAX_PICTURE_BYTES) return { ok: false, reason: TOO_LARGE }
  const type = sniffPicture(data)
  if (type === null) return { ok: false, reason: 'That file is not a picture Orivon can use. Choose a PNG, JPEG, WebP, GIF or AVIF image.' }
  return { ok: true, type, mime: MIME[type] }
}
