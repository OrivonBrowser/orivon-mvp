// Progress arrives many times a second; a page needs to hear of it a few times. The first change goes out at
// once, the rest of a burst are folded into one sent when the interval ends. Changes to different downloads
// fold into "the list changed", which the page answers by reading it again.
import type { DownloadChange } from './download-types.js'

export function throttleChanges (send: (change: DownloadChange) => void, intervalMs = 250): (change: DownloadChange) => void {
  let timer: ReturnType<typeof setTimeout> | undefined
  let held: { readonly change: DownloadChange } | undefined

  const release = (): void => {
    timer = undefined
    if (held === undefined) return
    const { change } = held
    held = undefined
    send(change)
    timer = setTimeout(release, intervalMs)
  }

  return (change) => {
    if (timer === undefined) {
      send(change)
      timer = setTimeout(release, intervalMs)
      return
    }
    const sameDownload = held !== undefined && held.change !== null && change !== null && held.change.id === change.id
    held = held === undefined || sameDownload ? { change } : { change: null }
  }
}
