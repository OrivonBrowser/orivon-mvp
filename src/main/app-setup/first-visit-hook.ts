// Where a verifier-served app's first visit begins (ADR-0076). A tab's top-level GET to an origin Orivon has never
// held starts the visit in the default session's `onBeforeRequest` and is let go at once: the page loads as an
// ordinary website, with no grant, while the manifest is read and the app cached beside it. Allow reloads the tab.
import type { CallbackResponse, OnBeforeRequestListenerDetails, WebContents } from 'electron'
import { originFromUrl } from '../../broker/policy/origin.js'
import type { DialogCaller } from '../consent/request-grant.js'
import type { FirstVisit } from '../install/first-visit.js'
import { holdNavigation } from '../shell/navigation-hold.js'
import { tabHost } from './tab-host.js'
import type { TabScreens, TabSetup } from './tab-screens.js'

export interface HookDeps {
  /** Read at the moment of use: the first visit and the screens are published after the hook is registered. */
  readonly firstVisit: () => FirstVisit | undefined
  readonly tabSetup: () => TabSetup | undefined
  readonly contentsById: (id: number) => WebContents | undefined
  readonly windowForSender: (contents: WebContents) => unknown
}

/** The tab as a question sees it: asked about the address being opened, so it still counts while that has not committed. */
function callerFor (contents: WebContents, screens: TabScreens, windowForSender: HookDeps['windowForSender']): DialogCaller {
  return {
    window: () => windowForSender(contents),
    contents: () => contents,
    hold: () => holdNavigation(contents),
    stillOn: () => !screens.moved()
  }
}

export function firstVisitBeforeRequest (deps: HookDeps): (details: OnBeforeRequestListenerDetails, current: CallbackResponse) => Promise<CallbackResponse> {
  return async (details, current) => {
    if (details.resourceType !== 'mainFrame' || details.method !== 'GET') return current
    const visit = deps.firstVisit()
    const setup = deps.tabSetup()
    const contents = details.webContentsId === undefined ? undefined : deps.contentsById(details.webContentsId)
    const origin = originFromUrl(details.url)
    if (visit === undefined || setup === undefined || contents === undefined || origin === null) return current
    // The request is never held: the page loads as an ordinary website while the visit reads the manifest beside it.
    void visit.kindOf(origin).then(async (kind) => {
      if (kind !== 'first') return
      const screens = setup(contents, details.url)
      if (screens === undefined) return
      const host = tabHost(screens, () => details.url)
      const result = await visit.run(origin, details.url, callerFor(contents, screens, deps.windowForSender), host, screens.signal)
      // A reload or a link inside the origin is the visit already running; the person's dismissal stands for the run.
      if (result.outcome === 'duplicate' || result.outcome === 'later') { host.end(); return }
      // Another visit of this origin finished first and let it in: this tab, loaded as a website, follows it.
      if (result.outcome === 'known' || result.outcome === 'settling') host.enter()
    }).catch((error: unknown) => {
      console.error('[first-visit] the visit failed; the page stays an ordinary website', origin, error)
    })
    return current
  }
}
