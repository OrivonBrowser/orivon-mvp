// The place a verifier-served app's first page is held back (ADR-0074). A tab's top-level GET to an origin
// Orivon has never held is paused in the default session's `onBeforeRequest`, so no byte of the app's own
// HTML, and none of its script, reaches the tab until the person has answered and the files are checked.
// Only then is the request let go (the site is no app), or cancelled while the tab is sent into the app
// through the address bar's own path, which puts it in the app's session before anything loads.
import type { CallbackResponse, OnBeforeRequestListenerDetails, WebContents } from 'electron'
import { originFromUrl } from '../../broker/policy/origin.js'
import type { DialogCaller } from '../consent/request-grant.js'
import type { FirstVisit, FirstVisitResult, SetupHost } from '../install/first-visit.js'
import { holdNavigation } from '../shell/navigation-hold.js'
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
    stillOn: () => !contents.isDestroyed() && !screens.moved()
  }
}

export function firstVisitBeforeRequest (deps: HookDeps): (details: OnBeforeRequestListenerDetails, current: CallbackResponse) => Promise<CallbackResponse> {
  return async (details, current) => {
    if (details.resourceType !== 'mainFrame' || details.method !== 'GET') return current
    const visit = deps.firstVisit()
    const setup = deps.tabSetup()
    const contents = deps.contentsById(details.webContentsId)
    const origin = originFromUrl(details.url)
    if (visit === undefined || setup === undefined || contents === undefined || origin === null) return current
    if (await visit.kindOf(origin) !== 'first') return current
    const screens = setup(contents, details.url)
    if (screens === undefined) return current

    return await new Promise<CallbackResponse>((resolve) => {
      let answered = false
      const answer = (response: CallbackResponse, then?: () => void): void => {
        if (answered) return
        answered = true
        screens.end()
        then?.()
        resolve(response)
      }
      const host: SetupHost = {
        show: (stage) => { screens.show(stage) },
        sheet: async (sheet) => await screens.sheet(sheet),
        enter: () => { answer({ cancel: true }, () => { screens.navigate(details.url) }) },
        plain: () => { answer(current) },
        end: () => { answer({ cancel: true }) }
      }
      const settle = (result: FirstVisitResult): void => {
        if (result.outcome === 'known') host.enter()
        else if (result.outcome === 'declined') host.plain()
        else host.end()
      }
      visit.run(origin, details.url, callerFor(contents, screens, deps.windowForSender), host).then(settle).catch((error: unknown) => {
        console.error('[first-visit] the visit failed; the page loads as an ordinary website', origin, error)
        host.plain()
      })
    })
  }
}
