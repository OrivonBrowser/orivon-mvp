// The Electron half of the carry: a cookie jar over a session, and a hidden page at the origin in a session. The page is a
// view no window holds, as the child host's is (`../children/child-host.ts`), and shows the shell's empty document
// (`../../loader/electron/carry-page.ts`), so no code of the app or of a website runs in it (a worker is bypassed, and a page it answered is refused).

import { WebContentsView } from 'electron'
import type { Cookie, Session, WebContents } from 'electron'
import { carryPageUrl } from '../../loader/electron/carry-page.js'
import { lockNavigation } from '../shell/lock-navigation.js'
import type { CarryPage, CookieJar } from './carry-runner.js'
import type { CookieToSet, OldCookie } from './cookies.js'

/** The longest one call to a hidden page may take: a page that does not answer in this long has stopped. */
export const CALL_LIMIT_MS = 120_000

/** What the page shows once loaded: where it is, whether a service worker controls it, and how many scripts it holds. */
const SETTLED_PROBE = 'JSON.stringify({ origin: self.origin, controlled: navigator.serviceWorker !== undefined && navigator.serviceWorker.controller !== null, scripts: document.scripts.length })'

/** The views of the pages that are open. Electron destroys a view's page when the view object is collected, so a page is kept alive by being listed here, not by its `webContents`. */
const openViews = new Set<WebContentsView>()

const asOld = (cookie: Cookie): OldCookie => ({
  name: cookie.name,
  value: cookie.value,
  ...(cookie.domain === undefined ? {} : { domain: cookie.domain }),
  ...(cookie.hostOnly === undefined ? {} : { hostOnly: cookie.hostOnly }),
  ...(cookie.path === undefined ? {} : { path: cookie.path }),
  ...(cookie.secure === undefined ? {} : { secure: cookie.secure }),
  ...(cookie.httpOnly === undefined ? {} : { httpOnly: cookie.httpOnly }),
  ...(cookie.session === undefined ? {} : { session: cookie.session }),
  ...(cookie.expirationDate === undefined ? {} : { expirationDate: cookie.expirationDate }),
  sameSite: cookie.sameSite
})

export function cookieJarOf (target: Session): CookieJar {
  return {
    all: async () => (await target.cookies.get({})).map(asOld),
    find: async (url, name) => (await target.cookies.get({ url, name })).map(asOld),
    set: async (cookie: CookieToSet) => { await target.cookies.set(cookie) }
  }
}

/** Puts the empty document of `origin` in `contents`, past any worker, and checks that it is the shell's own. */
async function load (contents: WebContents, origin: string): Promise<void> {
  contents.setAudioMuted(true)
  contents.setWebRTCIPHandlingPolicy('disable_non_proxied_udp')
  lockNavigation(contents)
  // A worker the app registered answers a navigation to its origin, and its answer could be the app's own page: see README.md's Design notes.
  await contents.loadURL('about:blank')
  contents.debugger.attach('1.3')
  await contents.debugger.sendCommand('Network.enable')
  await contents.debugger.sendCommand('Network.setBypassServiceWorker', { bypass: true })
  await contents.loadURL(carryPageUrl(origin))
  const settled: unknown = await contents.executeJavaScript(SETTLED_PROBE)
  const facts = typeof settled === 'string' ? (JSON.parse(settled) as { origin?: string, controlled?: boolean, scripts?: number }) : {}
  if (facts.origin !== new URL(origin).origin) throw new Error(`the empty document settled at ${String(facts.origin)}, not at the origin`)
  if (facts.controlled !== false || facts.scripts !== 0) throw new Error(`the empty document is not the shell's: a worker answered it, or it holds a script (${String(settled)})`)
}

/** Opens the empty document at `origin` in `target` in a view no window holds, and returns the page. Rejects when the document is not at `origin`. */
export async function openCarryPage (target: Session, origin: string, limitMs: number = CALL_LIMIT_MS): Promise<CarryPage> {
  const view = new WebContentsView({
    webPreferences: {
      session: target,
      sandbox: true,
      contextIsolation: true,
      nodeIntegration: false,
      offscreen: true,
      backgroundThrottling: false,
      // Nobody watches the page: a native alert box could never be answered.
      disableDialogs: true
    }
  })
  const contents = view.webContents
  openViews.add(view)
  const close = (): void => {
    openViews.delete(view)
    if (!contents.isDestroyed()) contents.close()
  }
  let timer: NodeJS.Timeout | undefined
  try {
    await Promise.race([
      load(contents, origin),
      new Promise<never>((_resolve, reject) => { timer = setTimeout(() => { reject(new Error('the empty document did not load')) }, limitMs) })
    ])
  } catch (error) {
    close()
    throw error
  } finally {
    clearTimeout(timer)
  }
  return {
    close,
    run: async (code) => {
      let timer: NodeJS.Timeout | undefined
      try {
        const answer: unknown = await Promise.race([
          contents.executeJavaScript(code),
          new Promise<never>((_resolve, reject) => { timer = setTimeout(() => { reject(new Error('the hidden page did not answer')) }, limitMs) })
        ])
        if (typeof answer !== 'string') throw new Error('the hidden page answered with something that is not text')
        return answer
      } finally {
        clearTimeout(timer)
      }
    }
  }
}
