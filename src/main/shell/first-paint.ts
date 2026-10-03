// Resolves once a page has drawn its first frame, or after a time limit.
import type { WebContents } from 'electron'

/** How long a page may take before the caller stops waiting for it: a page that never loads (a dead
 * renderer, a load that fails) must not keep the page in front of it on the screen for good. */
export const FIRST_PAINT_LIMIT_MS = 1500

/** How long the page's background pictures may take to decode before the frames are waited on anyway: a picture
 * that never decodes (a broken file) must not hold the page in front for the whole of `FIRST_PAINT_LIMIT_MS`. */
export const IMAGE_DECODE_LIMIT_MS = 800

/** How long the page may take to report that its first content was presented, once its frames have run. */
export const PRESENT_LIMIT_MS = 400

/** A page older than this when the script runs is not waited on for that report: one that loaded while it was
 * hidden never makes one, so waiting would hold the page in front for nothing. */
export const FRESH_PAGE_MS = 1000

/** Runs in the page. A view shows its flat colour until its first frame reaches the screen, and that frame is
 * late while a background picture is still decoding. So the script first decodes every `url(...)` its root, its
 * `::before` layer and its body paint (the decoded copy is the one the page's own paint then uses), then waits for
 * two animation frames (a second frame callback runs after the frame the first one scheduled has been drawn), then
 * for the browser's report that the first content was presented (a `first-contentful-paint` entry, which the
 * renderer adds when the frame is on the screen, not when it is made). Written as a function so the unit test can
 * run it. */
export function waitForPicturesScript (decodeLimitMs: number, presentLimitMs = PRESENT_LIMIT_MS): string {
  return `(() => {
  const urls = new Set()
  for (const style of [getComputedStyle(document.documentElement), getComputedStyle(document.documentElement, '::before'), getComputedStyle(document.body)]) {
    for (const match of style.backgroundImage.matchAll(/url\\((["']?)(.*?)\\1\\)/g)) urls.add(match[2])
  }
  const decoded = Promise.all([...urls].map((src) => {
    const image = new Image()
    image.src = src
    return image.decode().catch(() => {})
  }))
  const capped = new Promise((done) => setTimeout(done, ${String(decodeLimitMs)}))
  const frames = () => new Promise((done) => requestAnimationFrame(() => requestAnimationFrame(() => done())))
  const presented = () => new Promise((done) => {
    new PerformanceObserver((list, observer) => { if (list.getEntriesByName('first-contentful-paint').length > 0) { observer.disconnect(); done() } }).observe({ type: 'paint', buffered: true })
  })
  const presentedInTime = () => performance.now() > ${String(FRESH_PAGE_MS)} ? undefined : Promise.race([presented(), new Promise((done) => setTimeout(done, ${String(presentLimitMs)}))])
  return Promise.race([decoded, capped]).then(frames).then(presentedInTime)
})()`
}

/** Electron 44 has no first-paint event for a `WebContentsView` (`paint` is offscreen only), so the page is
 * asked (`waitForPicturesScript`) once `dom-ready` has given it its stylesheet. A view that is attached to a
 * window runs its frame callbacks even when another view is stacked over it. A page with no address yet is
 * waited on until `dom-ready`; one that loaded while its view was off the screen is not waited on for its
 * first-paint report, which it never makes. */
export function whenPainted (wc: WebContents, limitMs = FIRST_PAINT_LIMIT_MS): Promise<void> {
  return new Promise((resolve) => {
    let done = false
    const finish = (): void => {
      if (done) return
      done = true
      clearTimeout(timer)
      wc.removeListener('dom-ready', onReady)
      wc.removeListener('destroyed', finish)
      resolve()
    }
    const onReady = (): void => {
      try {
        void Promise.resolve(wc.executeJavaScript(waitForPicturesScript(IMAGE_DECODE_LIMIT_MS))).then(finish, finish)
      } catch {
        finish()
      }
    }
    const timer = setTimeout(finish, limitMs)
    timer.unref()
    wc.once('destroyed', finish)
    if (wc.getURL() !== '' && !wc.isLoading()) onReady()
    else wc.once('dom-ready', onReady)
  })
}
