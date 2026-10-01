// What happens when a server asks for a username and password: a tab gets a sheet, anything else keeps
// Electron's own answer (cancel). Pure over its dependencies, so a fake app can drive it.
import type { AuthenticationResponseDetails, AuthInfo, WebContents } from 'electron'
import type { requestSlot } from '../overlays/tab-slots.js'
import type { ShellWindow } from '../shell/window-registry.js'
import { AUTH_SHEET_OVERLAY } from './auth-names.js'
import type { AuthChallenges, AuthServer } from './auth-queue.js'

export interface LoginDeps {
  readonly challenges: AuthChallenges
  readonly findTab: (contents: WebContents) => { window: ShellWindow, tabId: string } | null
  /** Changes when the tab starts a new main-frame navigation. */
  readonly loadOf: (contents: WebContents) => number
  readonly ask: typeof requestSlot
  /** Shows the address a page is waiting on in the tab, or null to stop: the sheet names its server, the tab names the page. */
  readonly pending?: (contents: WebContents, url: string | null) => void
}

/** `isMainFrame` is reported but not typed. A build that does not report it leaves every request to be judged by the page the tab is on: a frame's navigation is a navigation request too. */
type LoginDetails = AuthenticationResponseDetails & { isMainFrame?: boolean }

const bare = (host: string): string => host.replace(/^\[|\]$/g, '').toLowerCase()

function portOf (url: URL): number {
  if (url.port !== '') return Number(url.port)
  return url.protocol === 'https:' ? 443 : 80
}

/** Whether `pageUrl` is the page of the server that asked. A page that is not on the web is nobody's match. */
export function isPageOfServer (pageUrl: string, server: AuthServer): boolean {
  let page: URL
  try {
    page = new URL(pageUrl)
  } catch {
    return false
  }
  if (page.protocol !== 'http:' && page.protocol !== 'https:') return false
  return bare(page.hostname) === bare(server.host) && portOf(page) === server.port
}

export function handleLogin (
  deps: LoginDeps,
  event: { preventDefault: () => void },
  contents: WebContents | null | undefined,
  details: LoginDetails,
  info: AuthInfo,
  callback: (username?: string, password?: string) => void
): void {
  const found = contents === null || contents === undefined ? null : deps.findTab(contents)
  // Not a tab (an extension's page, a guest, a shell view, a request of the app's own): Electron cancels it.
  if (found === null || contents === null || contents === undefined) return
  event.preventDefault()
  let url: URL
  try {
    url = new URL(details.url)
  } catch {
    callback()
    return
  }
  const showPending = (url: string | null): void => { deps.pending?.(contents, url) }
  const server: AuthServer = { scheme: url.protocol.replace(/:$/, ''), host: info.host, port: info.port, isProxy: info.isProxy, realm: info.realm }
  const mainFrame = details.isMainFrame === true
  const challenge = deps.challenges.add({
    owner: found.window,
    tabId: found.tabId,
    load: deps.loadOf(contents),
    server,
    first: details.firstAuthAttempt,
    insecure: !info.isProxy && url.protocol === 'http:',
    // A main-frame request is the page the person asked for; anything else is a part of some page.
    mismatch: !info.isProxy && !mainFrame && !isPageOfServer(contents.getURL(), server)
  }, (answer) => {
    showPending(null)
    if (answer === null) callback()
    else callback(answer.username, answer.password)
  }, () => { showPending(null); slot?.cancel() })
  if (challenge === null) return
  if (mainFrame) showPending(details.url)
  const slot = deps.ask({
    window: found.window,
    tabId: found.tabId,
    slot: 'center',
    overlay: AUTH_SHEET_OVERLAY,
    payload: { id: challenge.id },
    closed: () => { deps.challenges.cancel(challenge.id) }
  })
}
