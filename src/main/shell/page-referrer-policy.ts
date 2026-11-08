// Registered in `./shell-installers.ts`. Tied to Electron through the sessions' web requests. Keeps the `Referrer-Policy` header of the documents a tab has
// loaded, which no DOM property of the page shows, so that a navigation the shell re-issues in another session
// follows the policy the document was served with (./navigation-referrer.ts).
import type { WebContents } from 'electron'
import { originFromUrl } from '../../broker/policy/origin.js'
import { isOriginServedFromCacheSync } from '../../loader/electron/serve.js'
import { webRequestOwnerFor } from '../sessions/web-request-owner.js'
import { forEachWebsiteSession } from '../sessions/website-sessions.js'
import type { ShellInstaller } from './shell-installers.js'

/** Documents remembered per tab: a tab walks back through history to a page it loaded earlier, and its response is not seen again. */
const MAX_DOCUMENTS = 32

const WEB = ['http://*/*', 'https://*/*']
const WEB_ADDRESS = (url: string): boolean => url.startsWith('http://') || url.startsWith('https://')

/** Document address (without its fragment) to the header's value, empty when the response had none. */
const recorded = new WeakMap<WebContents, Map<string, string>>()

const documentKey = (url: string): string => url.split('#')[0] ?? url

/** Remembers the `Referrer-Policy` of the main-frame response at `url` in `contents`. */
export function noteDocumentResponse (contents: WebContents, url: string, headers: Record<string, string[]> | undefined): void {
  const found = Object.entries(headers ?? {}).filter(([name]) => name.toLowerCase() === 'referrer-policy').flatMap(([, values]) => values)
  let documents = recorded.get(contents)
  if (documents === undefined) recorded.set(contents, documents = new Map())
  documents.delete(documentKey(url))
  documents.set(documentKey(url), found.join(','))
  for (const oldest of documents.keys()) {
    if (documents.size <= MAX_DOCUMENTS) break
    documents.delete(oldest)
  }
}

/**
 * The `Referrer-Policy` the document that `contents` loaded at `documentUrl` came with (empty when it had none), or undefined
 * when its response was not seen: a page a service worker answered, or one loaded before this watch ran. A document Orivon's own
 * handler answers (an installed app, a verified name) carries none by construction.
 */
export function referrerPolicyHeaderOf (contents: WebContents, documentUrl: string): string | undefined {
  const known = recorded.get(contents)?.get(documentKey(documentUrl))
  if (known !== undefined) return known
  const origin = originFromUrl(documentUrl)
  return origin !== null && isOriginServedFromCacheSync(origin) ? '' : undefined
}

export const installReferrerPolicyWatch: ShellInstaller = {
  name: 'referrer-policy-watch',
  install: () => {
    forEachWebsiteSession((target) => {
      webRequestOwnerFor(target).onResponseStarted({ urls: WEB, types: ['mainFrame'] }, WEB_ADDRESS, (details) => {
        if (details.resourceType === 'mainFrame' && details.webContents !== undefined) noteDocumentResponse(details.webContents, details.url, details.responseHeaders)
      })
    })
  }
}
