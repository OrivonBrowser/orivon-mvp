// A download the person asked for from a menu (Save image as, Save link as, Save page as on a file) is started with
// `webContents.downloadURL`, for which Electron sets no user gesture. It is marked here as it starts, so the limits on
// what a page may download by itself (the automatic-downloads question, the per-tab rate) never apply to it.
import type { WebContents } from 'electron'

/** A mark this old was not the download that reached `will-download` now. */
const ASKED_WAIT_MS = 10_000

const asked = new WeakMap<object, Map<string, number>>()

const keyOf = (url: string): string => {
  try { return new URL(url).href } catch { return url }
}

/** Starts the download of `url` in `contents`, as one the person asked for. */
export function downloadAsked (contents: Pick<WebContents, 'downloadURL'>, url: string, now: number = Date.now()): void {
  const marks = asked.get(contents) ?? new Map<string, number>()
  marks.set(keyOf(url), now)
  asked.set(contents, marks)
  contents.downloadURL(url)
}

/** Whether the download of `url` in `contents` is one the person asked for a moment ago. The mark is used up. */
export function wasAsked (contents: WebContents | undefined, url: string, now: number = Date.now()): boolean {
  const marks = contents === undefined ? undefined : asked.get(contents)
  const key = keyOf(url)
  const at = marks?.get(key)
  if (marks === undefined || at === undefined) return false
  marks.delete(key)
  return now - at <= ASKED_WAIT_MS
}
