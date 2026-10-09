// Every web contents running in an app's own partition: its tabs, and the pages no tab shows (a popup, the host of a
// web context). Electron-bound: it asks the session.
import { session, webContents } from 'electron'
import type { WebContents } from 'electron'
import { partitionFor } from '../../broker/grants/origin-hash.js'
import { isOriginServedFromCacheSync } from '../../loader/electron/serve.js'

export function pagesInPartitionOf (origin: string): readonly WebContents[] {
  // Only an origin that has a partition: asking for one creates it, on disk.
  if (!isOriginServedFromCacheSync(origin)) return []
  const own = session.fromPartition(partitionFor(origin))
  return webContents.getAllWebContents().filter((contents) => !contents.isDestroyed() && contents.session === own)
}
