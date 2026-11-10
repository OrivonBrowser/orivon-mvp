// Every web contents that shows an app's origin or runs in its own partition: its tabs, and the pages no tab shows (a
// popup, the host of a web context). Electron-bound: it asks the session.
import { session, webContents } from 'electron'
import type { WebContents } from 'electron'
import { appSessionPartition } from '../shell/app-session.js'

/**
 * A page at the origin is the app's in whichever session it is: an app that runs where websites run has its popups
 * and hosts among the pages of every other site there. One with a partition of its own has that partition's pages too,
 * whatever address they show.
 */
export function pagesOfOrigin (origin: string): readonly WebContents[] {
  // Only an origin that has a partition: asking for one creates it, on disk.
  const partition = appSessionPartition(origin)
  const own = partition === undefined ? undefined : session.fromPartition(partition)
  return webContents.getAllWebContents().filter((contents) => !contents.isDestroyed() && (contents.session === own || originOfAddress(contents.getURL()) === origin))
}

/** The origin an address shows, as the URL parser spells it; undefined for an address with none. The shell's caller names origins this way. */
function originOfAddress (address: string): string | undefined {
  try {
    const { origin } = new URL(address)
    return origin === 'null' ? undefined : origin
  } catch {
    return undefined
  }
}
