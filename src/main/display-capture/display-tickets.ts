// One-shot tickets that tell the permission gate which `media` request with no device type is the display call
// Orivon's own preload made after the person picked (ADR-0055). Pure: time and randomness are injected, so every
// rule is unit-tested without a clock.
import { randomBytes } from 'node:crypto'

/** The pause after the last request arrives before the one held request is allowed, in which a second one would void the ticket. */
export const QUIET_WINDOW_MS = 250

/** How long a ticket lives from `open`, whether or not it was used. */
export const TICKET_TIMEOUT_MS = 10_000

/** A frame's identity: the tab's webContents id and the main frame's `processId:routingId`. */
export function ticketKey (webContentsId: number, processId: number, routingId: number): string {
  return `${webContentsId}:${processId}:${routingId}`
}

export interface DisplayTicketsDeps {
  now: () => number
  setTimer: (run: () => void, ms: number) => unknown
  clearTimer: (handle: unknown) => void
  nonce: () => string
}

export interface DisplayTickets<C> {
  /** Opens the frame's ticket, voiding an older one, and returns the nonce the preload must present. */
  open: (key: string, choice: C) => string
  /** A `media` request with no device type from the frame: held while a ticket is open, refused at once otherwise. */
  request: (key: string) => Promise<boolean>
  arm: (key: string, nonce: string) => void
  called: (key: string, nonce: string, rejectedEarly: boolean) => void
  /** Ends the frame's ticket and denies whatever it held: navigation, a destroyed frame, a renderer gone. */
  void: (key: string) => void
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

  function end (key: string, ticket: Ticket<C>): void {
    if (tickets.get(key) !== ticket) return
    tickets.delete(key)
    if (ticket.quiet !== undefined) deps.clearTimer(ticket.quiet)
    deps.clearTimer(ticket.expiry)
    const held = ticket.held
    ticket.held = []
    for (const request of held) request.resolve(false)
  }

  /** Allows the one held request when armed, called, and no other request arrived for the quiet window. */
  function settle (key: string, ticket: Ticket<C>): void {
    if (ticket.state !== 'open' || !ticket.armed || !ticket.called || ticket.held.length !== 1) return
    if (deps.now() - ticket.lastArrival < QUIET_WINDOW_MS) return
    const [request] = ticket.held
    ticket.state = 'allowed'
    ticket.held = []
    if (ticket.quiet !== undefined) deps.clearTimer(ticket.quiet)
    ticket.quiet = undefined
    request?.resolve(true)
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
        nonce: deps.nonce(), choice, state: 'open', armed: false, called: false, held: [], lastArrival: Number.NEGATIVE_INFINITY, quiet: undefined, expiry: undefined
      }
      ticket.expiry = deps.setTimer(() => { end(key, ticket) }, TICKET_TIMEOUT_MS)
      tickets.set(key, ticket)
      return ticket.nonce
    },

    async request (key) {
      const ticket = tickets.get(key)
      if (ticket?.state !== 'open') return false
      return await new Promise<boolean>((resolve) => {
        ticket.held.push({ resolve })
        ticket.lastArrival = deps.now()
        if (ticket.held.length > 1) { end(key, ticket); return }
        ticket.quiet = deps.setTimer(() => { settle(key, ticket) }, QUIET_WINDOW_MS)
        settle(key, ticket)
      })
    },

    arm (key, nonce) {
      const ticket = ticketFor(key, nonce)
      if (ticket === undefined) return
      ticket.armed = true
      settle(key, ticket)
    },

    called (key, nonce, rejectedEarly) {
      const ticket = ticketFor(key, nonce)
      if (ticket === undefined) return
      if (rejectedEarly || !ticket.armed) { end(key, ticket); return }
      ticket.called = true
      settle(key, ticket)
    },

    void (key) {
      const ticket = tickets.get(key)
      if (ticket !== undefined) end(key, ticket)
    },

    consumeDisplay (key) {
      const ticket = tickets.get(key)
      if (ticket?.state !== 'allowed') return undefined
      end(key, ticket)
      return { choice: ticket.choice, nonce: ticket.nonce }
    },

    awaitingDisplay: (key) => tickets.get(key)?.state === 'allowed',
    has: (key) => tickets.has(key)
  }
}
