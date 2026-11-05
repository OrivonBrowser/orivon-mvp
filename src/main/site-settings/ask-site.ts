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
import type { RestartReopens } from './site-prompt-text.js'

export const SITE_PROMPT_OVERLAY = 'site-prompt'

/** `dismiss` covers every way out but an answer: Escape, the close button, a navigation, a closed tab, a full queue. `restart` says that an allow also turns on a setting Orivon reads at start, so the question tells the person so. */
export type AskSite = (kinds: readonly SiteKind[], tab: WebContents, options?: { sysex?: boolean, restart?: boolean }) => Promise<SiteAnswer>

/** A question on its way to the person or on screen: what the overlay shows and how its answer is delivered. */
export interface PendingAsk {
  readonly id: string
  readonly window: ShellWindow
  readonly origin: string
  readonly kinds: readonly SiteKind[]
  readonly sysex: boolean
  readonly restart: boolean
  settle: (answer: SiteAnswer) => void
}

/** The offer to start Orivon again that follows a grant, held in main like a question. `run` starts it; the page of the overlay only names the button. */
export interface PendingRestart {
  readonly id: string
  readonly window: ShellWindow
  /** Decided when the offer is made and shown by the view; `run` was built with the same answer, so what the person reads is what happens. */
  readonly reopens: RestartReopens
  readonly run: () => void
}

const restarts = new Map<string, PendingRestart>()

export function pendingRestart (id: unknown): PendingRestart | undefined {
  return typeof id === 'string' ? restarts.get(id) : undefined
}

/** Held in main, by a random id: the overlay is told an id and never a site or a kind it could be made to misstate. */
const pending = new Map<string, PendingAsk>()

export function pendingAsk (id: unknown): PendingAsk | undefined {
  return typeof id === 'string' ? pending.get(id) : undefined
}

export interface AskSiteDeps {
  windows: Pick<WindowRegistry, 'findTab'>
}

/** A prompt shown under the address bar of one tab, held in main under a random id until it ends. */
interface Hold {
  readonly id: string
  /** Ends the prompt: closes its surface when it is up, and runs `release` once. */
  readonly end: () => void
}

interface HoldOptions {
  /** Records the prompt under `id`, before it is shown: the overlay asks for it by that id the moment it appears. */
  readonly keep: (id: string) => void
  /** The tab loaded a new page: whether that ends the prompt. */
  readonly endsOnNavigate: () => boolean
  /** Forgets the prompt, once, however it ended: an answer, the surface closing, the tab leaving or closing. */
  readonly release: (id: string) => void
}

/** The part a question and a restart offer share: the id, the slot under the address bar and the page-change watch. */
function holdPrompt (tab: WebContents, found: { readonly window: ShellWindow, readonly tabId: string }, mode: 'ask' | 'restart', options: HoldOptions): Hold {
  const id = randomBytes(12).toString('hex')
  let ended = false
  let handle: { cancel: () => void } | undefined
  function end (): void {
    if (ended) return
    ended = true
    tab.removeListener('did-navigate', onNavigate)
    options.release(id)
  }
  function onNavigate (): void {
    if (!options.endsOnNavigate()) return
    handle?.cancel()
    end()
  }
  tab.on('did-navigate', onNavigate)
  options.keep(id)
  handle = requestSlot({
    window: found.window,
    tabId: found.tabId,
    slot: 'address',
    overlay: SITE_PROMPT_OVERLAY,
    payload: { mode, id },
    anchor: () => crossingAnchor(found.window),
    closed: end
  })
  return { id, end }
}

export function createAskSite (deps: AskSiteDeps): AskSite {
  return (kinds, tab, options) => {
    const found = deps.windows.findTab(tab)
    const origin = originFromUrl(tab.getURL())
    if (found === null || origin === null) return Promise.resolve('dismiss')
    return new Promise<SiteAnswer>((resolve) => {
      let answer: SiteAnswer = 'dismiss'
      const hold = holdPrompt(tab, found, 'ask', {
        keep: (id) => {
          // The answer first, then the end: the end alone settles the ask as "not now".
          const settle = (given: SiteAnswer): void => { answer = given; hold.end() }
          pending.set(id, { id, window: found.window, origin, kinds, sysex: options?.sysex === true, restart: options?.restart === true, settle })
        },
        // The question is about the page that asked: a new page in the tab ends it, shown or not.
        endsOnNavigate: () => true,
        release: (id) => {
          pending.delete(id)
          resolve(answer)
        }
      })
    })
  }
}

/** Offers `tab` to start Orivon again with `run`, under the address bar; the offer ends with the page it was made on. */
export type OfferRestart = (tab: WebContents, offer: { readonly reopens: RestartReopens, readonly run: () => void }) => void

export function createOfferRestart (deps: AskSiteDeps): OfferRestart {
  return (tab, { reopens, run }) => {
    const found = deps.windows.findTab(tab)
    if (found === null) return
    holdPrompt(tab, found, 'restart', {
      keep: (id) => { restarts.set(id, { id, window: found.window, reopens, run }) },
      endsOnNavigate: () => true,
      release: (id) => { restarts.delete(id) }
    })
  }
}

let bound: AskSite | undefined

/** The ask the installer built over this process's windows; `dismiss` until then. */
export const askSite: AskSite = (kinds, tab, options) => bound === undefined ? Promise.resolve('dismiss') : bound(kinds, tab, options)

export function bindAskSite (ask: AskSite | undefined): void {
  bound = ask
}
