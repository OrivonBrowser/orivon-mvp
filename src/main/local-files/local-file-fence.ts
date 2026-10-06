import type { WebRequestOwner } from '../sessions/web-request-owner.js'
import { localPartitionFor } from './partition.js'

/**
 * Whether a `file:` document load (a main frame, a frame or an object) is one `partition` serves. A file
 * belongs to exactly one local session (`localPartitionFor`), so a page in one never frames, links to or
 * embeds a file that runs in another: the shared session's pages cannot frame a granted file, and a
 * granted file's session holds that file alone. A URL that names no local file is refused.
 */
export function fenceAllows (url: string, partition: string): boolean {
  return localPartitionFor(url) === partition
}

/**
 * Cancels, in a local session, every document-level `file:` load that belongs to another one. It sees
 * `mainFrame`, `subFrame` and `object` (a frame's `<object>` and `<embed>`) only: scripts, styles and
 * images of a local page load freely and are not readable as data (README.md's Design notes). A
 * cancelled main frame reports `ERR_BLOCKED_BY_CLIENT` (-20), which is how a tab learns to move to the
 * session the file belongs in (`../shell/tab-partition.ts`).
 */
export function installLocalFileFence (owner: Pick<WebRequestOwner, 'onBeforeRequest'>, partition: string): void {
  owner.onBeforeRequest(
    0,
    { urls: ['file:///*'], types: ['mainFrame', 'subFrame', 'object'] },
    (url) => url.startsWith('file:'),
    (details, current) => fenceAllows(details.url, partition) ? current : { cancel: true }
  )
}
