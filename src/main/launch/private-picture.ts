// The new tab's picture is a preference a private session starts with, but a copy of up to 20 MB: it is copied
// asynchronously, with the extensions (./private-extensions.ts), before the session starts, never with the small
// preference files that `createPrivateDir` copies on the spot.
import { existsSync } from 'node:fs'
import { copyFile } from 'node:fs/promises'
import { join } from 'node:path'
import { NEW_TAB_BACKGROUND_FILE } from '../newtab/background-image.js'

/** The opening profile holds a picture, so a caller with nothing else to wait for need not wait. */
export function hasPrivatePicture (from: string): boolean {
  return existsSync(join(from, NEW_TAB_BACKGROUND_FILE))
}

/** Gives the private session folder `into` the new tab's picture of the profile folder `from`, when there is one. Resolves to whether it did, and never rejects: a session without it shows the Orivon picture. */
export async function copyPrivatePicture (from: string, into: string): Promise<boolean> {
  if (!hasPrivatePicture(from)) return false
  try {
    await copyFile(join(from, NEW_TAB_BACKGROUND_FILE), join(into, NEW_TAB_BACKGROUND_FILE))
    return true
  } catch (error) {
    console.warn('[private] the new tab picture could not be copied, so this private window shows the Orivon one:', error)
    return false
  }
}
