// What happens between a page's call to `getDisplayMedia` and the ticket the permission gate grants against: the
// checks on who asked, the picker, and the preload's two messages that arm the ticket. Pure over its dependencies;
// `display-ipc.ts` reads the messages and `install-display-capture.ts` wires the dependencies.
import type { WebContents } from 'electron'
import type { DisplayPolicy } from './display-policy.js'
import { TICKET_TIMEOUT_MS, type DisplayTickets } from './display-tickets.js'
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
  tickets: Pick<DisplayTickets<DisplayChoice>, 'open' | 'void' | 'arm' | 'called'>
  policy: DisplayPolicy
  choose: ChooseDisplaySource
  shares: { tracksEnded: (requester: WebContents, nonce: string) => void }
  now: () => number
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
  /** The tab's page is going away or being replaced: closes its picker, voids its ticket, forgets what it asked. */
  endForTab: (contents: WebContents) => void
}

interface TabState {
  picking: AbortController | undefined
  /** A page that was refused or cancelled needs a fresh gesture before it may ask again: a page cannot loop the picker. */
  needsActivation: boolean
  /** A ticket this tab's preload has not yet used: a second pick would void it under the call that holds it. */
  ticket: { readonly nonce: string, readonly openedAt: number } | undefined
}

const refused = (reason: 'denied' | 'activation' | 'busy'): PickReply => ({ type: 'refused', reason })

export function createDisplayGate (deps: DisplayGateDeps): DisplayGate {
  const states = new WeakMap<WebContents, TabState>()
  const stateOf = (contents: WebContents): TabState => {
    let state = states.get(contents)
    if (state === undefined) states.set(contents, state = { picking: undefined, needsActivation: false, ticket: undefined })
    return state
  }

  async function pick (contents: WebContents, request: PickRequest): Promise<PickReply> {
    if (!deps.isTab(contents) || !deps.showing(contents)) return refused('denied')
    const state = stateOf(contents)
    if (state.ticket !== undefined && deps.now() - state.ticket.openedAt >= TICKET_TIMEOUT_MS) state.ticket = undefined
    if (state.picking !== undefined || state.ticket !== undefined) return refused('busy')
    if (state.needsActivation && !request.activation) return refused('activation')
    const origin = deps.mainFrameOrigin(contents)
    if (origin === null) return refused('denied')

    const controller = new AbortController()
    state.picking = controller
    try {
      const allowed = await deps.policy.decide(contents, origin)
      const choice = allowed && !controller.signal.aborted
        ? await deps.choose({ tab: contents, origin, isApp: deps.policy.isApp(origin), audio: request.audio, hints: request.hints }, controller.signal)
        : null
      // The page moved on or the tab closed while the person chose: the choice was about a page that is not there.
      const key = contents.isDestroyed() || controller.signal.aborted || deps.mainFrameOrigin(contents) !== origin ? undefined : deps.frameKey(contents)
      if (choice === null || key === undefined) {
        state.needsActivation = true
        return refused('denied')
      }
      state.needsActivation = false
      const nonce = deps.tickets.open(key, choice)
      state.ticket = { nonce, openedAt: deps.now() }
      return { type: 'go', nonce }
    } catch (error) {
      console.error('[display-capture] the picker failed:', error)
      state.needsActivation = true
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
      const state = states.get(contents)
      if (state?.ticket?.nonce === nonce) state.ticket = undefined
      const key = deps.frameKey(contents)
      if (key !== undefined) deps.tickets.called(key, nonce, rejectedEarly)
    },
    tracksEnded (contents, nonce) {
      deps.shares.tracksEnded(contents, nonce)
    },
    endForTab (contents) {
      const state = states.get(contents)
      state?.picking?.abort()
      states.delete(contents)
      const key = deps.frameKey(contents)
      if (key !== undefined) deps.tickets.void(key)
    }
  }
}
