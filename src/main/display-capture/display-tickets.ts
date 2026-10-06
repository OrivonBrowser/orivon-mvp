// One-shot tickets that tell the permission gate which `media` request with no device type is the display call
// Orivon's own preload made after the person picked (ADR-0055). Pure: time and randomness are injected, so every
// rule is unit-tested without a clock.
import { randomBytes } from 'node:crypto'

/** The pause after the last request arrives before the one held request is allowed, in which a second one would void the ticket. */
export const QUIET_WINDOW_MS = 250

/**
 * How long before the preload's `arm` message a request may have arrived and still be allowed. The preload sends `arm`
 * in the same step as, and before, its call, but the message and the request travel on different paths, so the request
 * can overtake it; a request that did so by more than this came from the page, not from the preload's step. Provisional:
 * overtakes measured in the shell were under 1 ms, so this leaves room for a loaded machine. It bounds how long a page's
 * own request, sent before the preload's step, can wait for the preload's arm and still be taken for the preload's.
 */
export const EARLY_SLACK_MS = 50

/** How long a ticket lives from `open`, whether or not it was used. */
export const TICKET_TIMEOUT_MS = 10_000

/**
 * How long a frame stays suspect after a request with no ticket: no picker is shown, and a request held against a ticket
 * opened meanwhile voids it, since the held request may be that request's twin. Suspicion refuses and never ends a
 * renderer: a page's own wrapped call, an extension's content script and a ported app's legacy call can each make a
 * request that reaches main with no ticket, and the share registry's confirmation is what catches a capture the page
 * was handed by such a request. Provisional: it only has to outlast the picker's round trip; what would settle it is a
 * measured honest page that is refused by it.
 */
export const SUSPECT_MS = 5000

/** A frame's identity: the tab's webContents id and the main frame's `processId:routingId`. */
export function ticketKey (webContentsId: number, processId: number, routingId: number): string {
  return `${webContentsId}:${processId}:${routingId}`
}

export interface DisplayTicketsDeps {
  now: () => number
  setTimer: (run: () => void, ms: number) => unknown
  clearTimer: (handle: unknown) => void
  nonce: () => string
  /** Runs when a ticket ends without its choice having been taken by the display handler: refused, voided, timed out. */
  onEnd?: (key: string, nonce: string) => void
}

export interface DisplayTickets<C> {
  /** Opens the frame's ticket, voiding an older one, and returns the nonce the preload must present. */
  open: (key: string, choice: C) => string
  /**
   * A `media` request with no device type from the frame: held while a ticket is open, refused at once otherwise. A
   * refusal for want of a ticket marks the frame suspect, and voids a ticket that was allowed and not yet taken.
   */
  request: (key: string) => Promise<boolean>
  /** True for `SUSPECT_MS` after the frame made a request with no ticket: no picker is shown and no ticket opens meanwhile. */
  suspect: (key: string) => boolean
  /** A new document committed in the tab: the suspicion its frames earned belongs to the old one. */
  forgetTab: (webContentsId: number) => void
  arm: (key: string, nonce: string) => void
  called: (key: string, nonce: string, rejectedEarly: boolean) => void
  /** Ends the frame's ticket and denies whatever it held: navigation, a destroyed frame, a renderer gone. */
  void: (key: string) => void
  /** Voids every ticket that was allowed and not yet taken: the display handler was asked for a frame it cannot name. */
  voidAllowed: () => void
  /** The choice and the nonce for the display handler, once, and only for a ticket that allowed its request. */
  consumeDisplay: (key: string) => { readonly choice: C, readonly nonce: string } | undefined
  /** True when a request was allowed and the display handler has not taken the choice. */
  awaitingDisplay: (key: string) => boolean
  has: (key: string) => boolean
}

interface Held { resolve: (granted: boolean) => void }

interface Ticket<C> {
  readonly nonce: string
  readonly choice: C
  state: 'open' | 'allowed'
  armed: boolean
  called: boolean
  held: Held[]
  lastArrival: number
  /** When the preload said its call was made. */
  calledAt: number
  /** When the first request that arrived before `arm` did, if one did. */
  earlyAt: number | undefined
  quiet: unknown
  expiry: unknown
}

const defaultDeps: DisplayTicketsDeps = {
  now: () => Date.now(),
  setTimer: (run, ms) => setTimeout(run, ms),
  clearTimer: (handle) => { clearTimeout(handle as ReturnType<typeof setTimeout>) },
  nonce: () => randomBytes(16).toString('hex')
}

export function createDisplayTickets<C> (overrides: Partial<DisplayTicketsDeps> = {}): DisplayTickets<C> {
  const deps = { ...defaultDeps, ...overrides }
  const tickets = new Map<string, Ticket<C>>()
  const suspectUntil = new Map<string, number>()

  function prune (): void {
    const now = deps.now()
    for (const [key, until] of suspectUntil) if (until <= now) suspectUntil.delete(key)
  }

  const suspect = (key: string): boolean => (suspectUntil.get(key) ?? Number.NEGATIVE_INFINITY) > deps.now()

  /** Ends the ticket and denies what it held; `taken` is the display handler's consuming it, which is no failure to report. */
  function end (key: string, ticket: Ticket<C>, taken = false): void {
    if (tickets.get(key) !== ticket) return
    tickets.delete(key)
    if (ticket.quiet !== undefined) deps.clearTimer(ticket.quiet)
    deps.clearTimer(ticket.expiry)
    const held = ticket.held
    ticket.held = []
    for (const request of held) request.resolve(false)
    if (!taken) deps.onEnd?.(key, ticket.nonce)
  }

  /** The moment the quiet window ends: it runs from the later of the last request and the called message. */
  const quietEnd = (ticket: Ticket<C>): number => Math.max(ticket.lastArrival, ticket.calledAt) + QUIET_WINDOW_MS

  /** Allows the one held request when armed, called, and nothing else arrived for the quiet window after both. */
  function settle (key: string, ticket: Ticket<C>): void {
    if (ticket.state !== 'open' || !ticket.armed || !ticket.called || ticket.held.length !== 1) return
    // A timer can fire a little before the clock reads its time: wait again for what is left.
    if (deps.now() < quietEnd(ticket)) { schedule(key, ticket); return }
    const [request] = ticket.held
    ticket.state = 'allowed'
    ticket.held = []
    if (ticket.quiet !== undefined) deps.clearTimer(ticket.quiet)
    ticket.quiet = undefined
    request?.resolve(true)
  }

  /** Waits out the rest of the quiet window, then tries to allow. */
  function schedule (key: string, ticket: Ticket<C>): void {
    if (ticket.quiet !== undefined) deps.clearTimer(ticket.quiet)
    ticket.quiet = deps.setTimer(() => { settle(key, ticket) }, Math.max(0, quietEnd(ticket) - deps.now()))
  }

  function ticketFor (key: string, nonce: string): Ticket<C> | undefined {
    const ticket = tickets.get(key)
    if (ticket === undefined || ticket.state !== 'open') return undefined
    if (ticket.nonce !== nonce) { end(key, ticket); return undefined }
    return ticket
  }

  return {
    open (key, choice) {
      const older = tickets.get(key)
      if (older !== undefined) end(key, older)
      const ticket: Ticket<C> = {
        nonce: deps.nonce(), choice, state: 'open', armed: false, called: false, held: [], lastArrival: Number.NEGATIVE_INFINITY, calledAt: Number.NEGATIVE_INFINITY, earlyAt: undefined, quiet: undefined, expiry: undefined
      }
      ticket.expiry = deps.setTimer(() => { end(key, ticket) }, TICKET_TIMEOUT_MS)
      tickets.set(key, ticket)
      return ticket.nonce
    },

    async request (key) {
      const ticket = tickets.get(key)
      if (ticket?.state !== 'open') {
        prune()
        suspectUntil.set(key, deps.now() + SUSPECT_MS)
        // An allowed ticket is voided too: the display handler must not serve a request that may not be the preload's.
        if (ticket !== undefined) end(key, ticket)
        return false
      }
      // A request held while the frame is suspect: the frame has shown it makes requests the preload did not.
      if (suspect(key)) { end(key, ticket); return false }
      return await new Promise<boolean>((resolve) => {
        ticket.held.push({ resolve })
        ticket.lastArrival = deps.now()
        if (ticket.held.length > 1) { end(key, ticket); return }
        // Held, and judged when `arm` arrives: the preload's own request can overtake its arm message by a moment.
        if (!ticket.armed) ticket.earlyAt = deps.now()
        schedule(key, ticket)
        settle(key, ticket)
      })
    },

    arm (key, nonce) {
      const ticket = ticketFor(key, nonce)
      if (ticket === undefined) return
      // A request that preceded the arm message by more than the slack was not sent in the preload's step.
      if (ticket.earlyAt !== undefined && deps.now() - ticket.earlyAt > EARLY_SLACK_MS) { end(key, ticket); return }
      ticket.armed = true
      settle(key, ticket)
    },

    called (key, nonce, rejectedEarly) {
      const ticket = ticketFor(key, nonce)
      if (ticket === undefined) return
      if (rejectedEarly || !ticket.armed) { end(key, ticket); return }
      ticket.called = true
      ticket.calledAt = deps.now()
      if (ticket.held.length === 1) schedule(key, ticket)
      settle(key, ticket)
    },

    void (key) {
      const ticket = tickets.get(key)
      if (ticket !== undefined) end(key, ticket)
    },

    voidAllowed () {
      for (const [key, ticket] of [...tickets]) if (ticket.state === 'allowed') end(key, ticket)
    },

    forgetTab (webContentsId) {
      for (const key of [...suspectUntil.keys()]) if (key.startsWith(`${webContentsId}:`)) suspectUntil.delete(key)
    },

    consumeDisplay (key) {
      const ticket = tickets.get(key)
      if (ticket?.state !== 'allowed') return undefined
      end(key, ticket, true)
      return { choice: ticket.choice, nonce: ticket.nonce }
    },

    suspect,

    awaitingDisplay: (key) => tickets.get(key)?.state === 'allowed',
    has: (key) => tickets.has(key)
  }
}
