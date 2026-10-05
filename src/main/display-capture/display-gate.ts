// What happens between a page's call to `getDisplayMedia` and the ticket the permission gate grants against: the
// checks on who asked, the picker, and the preload's two messages that arm the ticket. Pure over its dependencies;
// `display-ipc.ts` reads the messages and `install-display-capture.ts` wires the dependencies.
import type { WebContents } from 'electron'
import type { DisplayPolicy } from './display-policy.js'
import type { DisplayTickets } from './display-tickets.js'
import type { ChooseDisplaySource, DisplayChoice, DisplayHints } from './types.js'

/** What a pick answers: the nonce the preload presents when it arms the ticket, or why the page is refused. */
export type PickReply =
  | { readonly type: 'go', readonly nonce: string }
  | { readonly type: 'refused', readonly reason: 'denied' | 'activation' | 'busy' }

export interface PickRequest {
  readonly audio: boolean
  readonly hints: DisplayHints
  /** The page had transient user activation when it called. */
  readonly activation: boolean
}

export interface DisplayGateDeps {
  tickets: Pick<DisplayTickets<DisplayChoice>, 'open' | 'void' | 'arm' | 'called' | 'has'>
  policy: DisplayPolicy
  choose: ChooseDisplaySource
  shares: { tracksEnded: (requester: WebContents, nonce: string) => void }
  /** An ordinary tab or an app's tab. */
  isTab: (contents: WebContents) => boolean
  /** The tab is on screen in a window; a picker for a background tab would land over another page. */
  showing: (contents: WebContents) => boolean
  /** The origin the tab's top frame committed, or null. */
  mainFrameOrigin: (contents: WebContents) => string | null
  /** The ticket key of the tab's top frame. */
  frameKey: (contents: WebContents) => string | undefined
}

export interface DisplayGate {
  pick: (contents: WebContents, request: PickRequest) => Promise<PickReply>
  arm: (contents: WebContents, nonce: string) => void
  called: (contents: WebContents, nonce: string, rejectedEarly: boolean) => void
  tracksEnded: (contents: WebContents, nonce: string) => void
  /** The tab's page is going away or being replaced: closes its picker and voids its ticket. A refusal is kept: see `TabState`. */
  endForTab: (contents: WebContents) => void
}

interface TabState {
  picking: AbortController | undefined
  /**
   * A page that was refused or cancelled needs a fresh gesture before it may ask again: a page cannot loop the picker.
   * It outlives `endForTab`, since a navigation that never commits (a download, a 204) leaves the same page in place;
   * it holds for the origin that was refused, so a tab that commits another origin starts fresh.
   */
  needsActivation: boolean
  refusedOrigin: string | null
}

const refused = (reason: 'denied' | 'activation' | 'busy'): PickReply => ({ type: 'refused', reason })

export function createDisplayGate (deps: DisplayGateDeps): DisplayGate {
  const states = new WeakMap<WebContents, TabState>()
  const stateOf = (contents: WebContents): TabState => {
    let state = states.get(contents)
    if (state === undefined) states.set(contents, state = { picking: undefined, needsActivation: false, refusedOrigin: null })
    return state
  }

  function refuse (state: TabState, origin: string): void {
    state.needsActivation = true
    state.refusedOrigin = origin
  }

  async function pick (contents: WebContents, request: PickRequest): Promise<PickReply> {
    if (!deps.isTab(contents) || !deps.showing(contents)) return refused('denied')
    const state = stateOf(contents)
    // A ticket still open is a call in flight: a second pick would void it. The tickets end their own on use and on timeout.
    const key = deps.frameKey(contents)
    if (state.picking !== undefined || (key !== undefined && deps.tickets.has(key))) return refused('busy')
    const origin = deps.mainFrameOrigin(contents)
    if (state.needsActivation && state.refusedOrigin === origin && !request.activation) return refused('activation')
    if (origin === null) return refused('denied')

    const controller = new AbortController()
    state.picking = controller
    try {
      const allowed = await deps.policy.decide(contents, origin)
      const choice = allowed && !controller.signal.aborted
        ? await deps.choose({ tab: contents, origin, isApp: deps.policy.isApp(origin), audio: request.audio, hints: request.hints }, controller.signal)
        : null
      // The page moved on or the tab closed while the person chose: the choice was about a page that is not there.
      const ticketKey = contents.isDestroyed() || controller.signal.aborted || deps.mainFrameOrigin(contents) !== origin ? undefined : deps.frameKey(contents)
      if (choice === null || ticketKey === undefined) {
        refuse(state, origin)
        return refused('denied')
      }
      state.needsActivation = false
      return { type: 'go', nonce: deps.tickets.open(ticketKey, choice) }
    } catch (error) {
      console.error('[display-capture] the picker failed:', error)
      refuse(state, origin)
      return refused('denied')
    } finally {
      if (state.picking === controller) state.picking = undefined
    }
  }

  return {
    pick,
    arm (contents, nonce) {
      const key = deps.frameKey(contents)
      if (key !== undefined) deps.tickets.arm(key, nonce)
    },
    called (contents, nonce, rejectedEarly) {
      const key = deps.frameKey(contents)
      if (key !== undefined) deps.tickets.called(key, nonce, rejectedEarly)
    },
    tracksEnded (contents, nonce) {
      deps.shares.tracksEnded(contents, nonce)
    },
    endForTab (contents) {
      const state = states.get(contents)
      state?.picking?.abort()
      if (state !== undefined) state.picking = undefined
      const key = deps.frameKey(contents)
      if (key !== undefined) deps.tickets.void(key)
    }
  }
}
