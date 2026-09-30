// The downloads button's memory, one per window: what has been seen, and whether this run has downloaded
// anything. The state part reads it and the bubble clears it.
import type { ShellWindow } from '../shell/window-registry.js'
import { DownloadAttention } from './download-attention.js'
import type { DownloadService } from './download-service.js'

type Source = Pick<DownloadService, 'list' | 'onChange'>

const trackers = new WeakMap<ShellWindow, DownloadAttention>()
const runs = new WeakMap<Source, { started: boolean }>()

/** The window's tracker, made level with the list the first time it is asked for. Whoever watches the service feeds it each change. */
export function attentionFor (window: ShellWindow, downloads: Source): DownloadAttention {
  let tracker = trackers.get(window)
  if (tracker === undefined) {
    tracker = new DownloadAttention(() => downloads.list())
    trackers.set(window, tracker)
  }
  return tracker
}

/** Whether a download has begun in this run of the browser, in any window. The list a previous run left does not count. */
export function startedThisRun (downloads: Source): boolean {
  let run = runs.get(downloads)
  if (run === undefined) {
    const made = { started: false }
    run = made
    runs.set(downloads, made)
    downloads.onChange((change) => { if (change !== null) made.started = true })
  }
  return run.started
}
