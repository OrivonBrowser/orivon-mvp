// The Electron half of the carry: a cookie jar over a session, and a hidden page at the origin in a session. The page is a
// view no window holds, as the child host's is (`../children/child-host.ts`), and shows the shell's empty document
// (`../../loader/electron/carry-page.ts`), so no code of the app or of a website runs in it.

import { WebContentsView } from 'electron'
import type { Cookie, Session } from 'electron'
import { carryPageUrl } from '../../loader/electron/carry-page.js'
import { lockNavigation } from '../shell/lock-navigation.js'
import type { CarryPage, CookieJar } from './carry-runner.js'
import type { CookieToSet, OldCookie } from './cookies.js'

/** The longest one call to a hidden page may take: a page that does not answer in this long has stopped. */
export const CALL_LIMIT_MS = 120_000

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
  const close = (): void => { if (!contents.isDestroyed()) contents.close() }
  try {
    contents.setAudioMuted(true)
    contents.setWebRTCIPHandlingPolicy('disable_non_proxied_udp')
    lockNavigation(contents)
    await contents.loadURL(carryPageUrl(origin))
    const settled: unknown = await contents.executeJavaScript('self.origin')
    if (settled !== new URL(origin).origin) throw new Error(`the empty document settled at ${String(settled)}, not at the origin`)
  } catch (error) {
    close()
    throw error
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
