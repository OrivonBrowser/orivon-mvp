// What a file must be to become the new tab's picture: one of five image formats, told by its leading bytes
// (a name proves nothing), and no larger than the cap.
import { sniffImageType } from '../reader/reader-images.js'

/** The copy's name in a profile's folder. It has no extension: its format is read from its bytes. */
export const NEW_TAB_BACKGROUND_FILE = 'new-tab-background'

export const MAX_PICTURE_BYTES = 20 * 1024 * 1024

export const TOO_LARGE = 'That picture is larger than 20 MB. Choose a smaller one.'

export type PictureCheck =
  | { readonly ok: true, readonly mime: string }
  | { readonly ok: false, readonly reason: string }

/** `size` is the file's size when `data` holds only its start. */
export function checkPicture (data: Uint8Array, size = data.length): PictureCheck {
  if (size > MAX_PICTURE_BYTES) return { ok: false, reason: TOO_LARGE }
  const mime = sniffImageType(data)
  if (mime === null) return { ok: false, reason: 'That file is not a picture Orivon can use. Choose a PNG, JPEG, WebP, GIF or AVIF image.' }
  return { ok: true, mime }
}
