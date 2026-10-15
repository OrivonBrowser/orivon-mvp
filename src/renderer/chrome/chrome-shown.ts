import type { ChromeModule } from './context.js'

/** Tells main when this page reads hidden, so main can show it again if the window is on screen: a view put over the
 * window after it was resized can leave the chrome hidden, and a hidden page stops drawing (its spinners freeze).
 * `page` is for tests. */
export function createChromeShown (page?: Pick<Document, 'visibilityState' | 'addEventListener'>): ChromeModule {
  return {
    name: 'chrome-shown',
    init: (ctx) => {
      const doc = page ?? document
      const report = (): void => {
        if (doc.visibilityState === 'hidden') void ctx.shell.act('chrome.hidden')
      }
      doc.addEventListener('visibilitychange', report)
      report()
    }
  }
}
