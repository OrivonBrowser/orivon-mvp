// The question "may this site use ...?" put to the person, under the address
// bar of the tab it came from. One function for every kind of ask: the
// permission engine calls it, and so will the features that ask about a
// device or a screen. The answer is the person's and is not stored here.
import { randomBytes } from 'node:crypto'
import type { WebContents } from 'electron'
import { originFromUrl } from '../../broker/policy/origin.js'
import { requestSlot } from '../overlays/tab-slots.js'
import { crossingAnchor } from '../shell/actions/prompt-anchor.js'
import type { ShellWindow, WindowRegistry } from '../shell/window-registry.js'
import type { SiteKind } from './kinds.js'
import type { SiteAnswer } from './site-asks-engine.js'

export const SITE_PROMPT_OVERLAY = 'site-prompt'

/** `dismiss` covers every way out but an answer: Escape, the close button, a navigation, a closed tab, a full queue. */
export type AskSite = (kinds: readonly SiteKind[], tab: WebContents, options?: { sysex?: boolean }) => Promise<SiteAnswer>

/** A question on its way to the person or on screen: what the overlay shows and how its answer is delivered. */
export interface PendingAsk {
  readonly id: string
  readonly window: ShellWindow
  readonly origin: string
  readonly kinds: readonly SiteKind[]
  readonly sysex: boolean
  settle: (answer: SiteAnswer) => void
}

/** Held in main, by a random id: the overlay is told an id and never a site or a kind it could be made to misstate. */
const pending = new Map<string, PendingAsk>()

export function pendingAsk (id: unknown): PendingAsk | undefined {
  return typeof id === 'string' ? pending.get(id) : undefined
}

export interface AskSiteDeps {
  windows: Pick<WindowRegistry, 'findTab'>
}

export function createAskSite (deps: AskSiteDeps): AskSite {
  return (kinds, tab, options) => {
    const found = deps.windows.findTab(tab)
    const origin = originFromUrl(tab.getURL())
    if (found === null || origin === null) return Promise.resolve('dismiss')
    return new Promise<SiteAnswer>((resolve) => {
      const id = randomBytes(12).toString('hex')
      let settled = false
      let handle: { cancel: () => void } | undefined
      function settle (answer: SiteAnswer): void {
        if (settled) return
        settled = true
        pending.delete(id)
        tab.removeListener('did-navigate', onNavigate)
        resolve(answer)
      }
      // The question is about the page that asked: a new page in the tab ends it, shown or not.
      function onNavigate (): void {
        handle?.cancel()
        settle('dismiss')
      }
      tab.once('did-navigate', onNavigate)
      pending.set(id, { id, window: found.window, origin, kinds, sysex: options?.sysex === true, settle })
      handle = requestSlot({
        window: found.window,
        tabId: found.tabId,
        slot: 'address',
        overlay: SITE_PROMPT_OVERLAY,
        payload: { mode: 'ask', id },
        anchor: () => crossingAnchor(found.window),
        closed: () => { settle('dismiss') }
      })
    })
  }
}

let bound: AskSite | undefined

/** The ask the installer built over this process's windows; `dismiss` until then. */
export const askSite: AskSite = (kinds, tab, options) => bound === undefined ? Promise.resolve('dismiss') : bound(kinds, tab, options)

export function bindAskSite (ask: AskSite | undefined): void {
  bound = ask
}
