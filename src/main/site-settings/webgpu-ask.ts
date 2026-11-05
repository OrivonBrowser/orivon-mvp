// Whether a website's page may have the WebGPU adapter it asked for, decided in main from the frame it was heard
// from. The page's wrapper (`../../preload/webgpu-ask.ts`) makes the call first and reports only whether Chromium gave
// an adapter; this module asks the person through the engine, as the camera is asked, and on an X11 session that has no
// adapter to give, also offers the graphics mode that makes one. Pure over its dependencies, so every branch is
// tested without a window. `webgpu-ask-ipc.ts` is where the page's message arrives.
import { originFromUrl } from '../../broker/policy/origin.js'
import type { SiteRequest } from './electron-names.js'
import type { NavigatingTab } from './page-access.js'
import type { RestartReopens } from './site-prompt-text.js'
import type { SiteAsksEngine } from './site-asks-engine.js'
import type { SiteDecision } from './site-settings-store.js'

/** What this run knows of the graphics mode that gives an X11 session WebGPU (`../graphics/`). */
export interface X11State {
  /** Orivon runs on an X11 session, where Settings offers the mode. */
  readonly offered: boolean
  /** This run started in the mode, so Chromium has already given an adapter wherever a card allows. */
  readonly onAtStart: boolean
  /** The guard turned the mode off after a bad run and it has not been turned on again. */
  readonly reverted: boolean
}

/** Whether a site that gets no adapter is still asked, because granting it turns the mode on: only where a restart gives one. */
export function x11QuestionApplies (state: X11State, isPrivate: boolean): boolean {
  return state.offered && !state.onAtStart && !state.reverted && !isPrivate
}

/**
 * What the start that follows a restart offer brings back. The saved session when the start-up choice restores it: this page is in
 * it, and its tab keeps a tunnel choice of its own. Otherwise the site of this page, opened from the command line, unless the tab
 * has such a choice: a launch address carries none, so the site would be fetched over the default route, and it is not reopened.
 */
export function reopensAfterRestart (state: { readonly restoresSession: boolean, readonly tabHasTunnel: boolean }): RestartReopens {
  if (state.restoresSession) return 'session'
  return state.tabHasTunnel ? 'none' : 'site'
}

/** The page the restart names on the command line: only the one a start that reopens `site` should open. */
export function addressAfterRestart (reopens: RestartReopens, page: string | undefined): string | undefined {
  return reopens === 'site' ? page : undefined
}

/** What the person is offered. `reopens` is what the note says, decided when the offer is made; `address` is what the restart opens, read when it is pressed, from what the tab and the settings hold then. */
export interface RestartOffer {
  readonly reopens: RestartReopens
  readonly address: () => string | undefined
}

export interface WebGpuAskDeps<T extends NavigatingTab & object> {
  /** The engine's `request`: undefined when `contents` is not an ordinary tab. */
  request: SiteAsksEngine<T>['request']
  /** The origin holds grants, so its permissions are its manifest's and no question asks for more. */
  isApp: (origin: string) => boolean
  /** The person's default for WebGPU is Block: it refuses a site with no answer, and an origin that holds grants too. */
  blockedByDefault: () => boolean
  /** What the person already told the site: a site with an answer is not asked again. */
  stored: (origin: string) => SiteDecision | undefined
  isPrivate: boolean
  x11: () => X11State
  /** Turns the mode on; false when the setting could not be changed. */
  turnOnX11: () => boolean
  /** The start-up choice brings the saved tabs and windows back. */
  restoresSession: () => boolean
  /** `contents`'s tab carries a tunnel choice of its own, which only that tab holds. */
  tabHasTunnel: (contents: T) => boolean
  /** The address `contents` shows now, which the restart opens again by its origin; undefined when the tab is gone. */
  pageOf: (contents: T) => string | undefined
  /** Offers the person a restart for `contents`'s site. */
  offerRestart: (contents: T, offer: RestartOffer) => void
}

/** Whether the page gets the adapter it asked for: `frameOrigin` is read by main from the sender frame, `adapter` is whether Chromium gave one. */
export type WebGpuAsk<T extends NavigatingTab & object> = (contents: T, frameOrigin: string, adapter: boolean) => Promise<boolean>

export function createWebGpuAsk<T extends NavigatingTab & object> (deps: WebGpuAskDeps<T>): WebGpuAsk<T> {
  /** The site each tab was last offered a restart for: a page that asks twice while the question is open shares one offer. */
  const offered = new WeakMap<T, string>()

  return async (contents, frameOrigin, adapter) => {
    const origin = originFromUrl(frameOrigin)
    // The question is for websites. A page with no web origin (a local file, an opaque origin) has no site to remember an
    // answer against, and keeps what Chromium gave it. A site served over ipfs, ipns, bzz or an `.eth` name is shown under
    // that scheme but runs at an `https:` origin of its own, so it is asked here as any website is.
    if (origin === null) return true
    if (deps.isApp(origin)) return !deps.blockedByDefault()
    const details = { isMainFrame: true, requestingUrl: origin }
    const plain: SiteRequest = { kinds: ['webgpu'], sysex: false }
    if (adapter) return await deps.request(plain, contents, details) ?? false

    // No adapter, so there is nothing to keep. A site that has an answer is never asked again (a person who turned the mode
    // off in Settings is not sent back to it by the sites they granted), but the engine still reads that answer: it notes it
    // for the address bar's chip and the site popup, which list what the page was asked, and asks nobody.
    if (deps.stored(origin) !== undefined) {
      await deps.request(plain, contents, details)
      return false
    }
    // Nothing stored: nobody is asked unless a restart would give an adapter.
    if (!x11QuestionApplies(deps.x11(), deps.isPrivate)) return false
    const granted = await deps.request({ ...plain, restart: true }, contents, details)
    if (granted !== true || offered.get(contents) === origin) return false
    offered.set(contents, origin)
    if (!deps.turnOnX11()) return false
    // Said once, when the offer is made; what the restart opens is decided again when it is pressed, and by the safe side: the
    // tab may have been given a tunnel, and the start-up choice changed, since.
    const state = (): { restoresSession: boolean, tabHasTunnel: boolean } => ({ restoresSession: deps.restoresSession(), tabHasTunnel: deps.tabHasTunnel(contents) })
    deps.offerRestart(contents, { reopens: reopensAfterRestart(state()), address: () => addressAfterRestart(reopensAfterRestart(state()), deps.pageOf(contents)) })
    return false
  }
}
