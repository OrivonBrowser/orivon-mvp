// When a routed fetch() may dial. Every request dials until the broker first
// refuses one for the origin's socket allowance; from then on the gate holds
// the tab to the number of requests that were live at that refusal, queues
// the rest in order, and hands each freed socket to the longest-waiting one.
// Runs in the isolated world and reaches ./fetch-route.ts's
// `installFetchRoute` as an argument (./expose-fetch-route.ts), since that
// function is serialised into the main world and can import nothing.
// README.md's Design notes has why fetch() waits where `orivon.net` refuses.
import type { FetchRouteGate } from './fetch-route-types.js'

interface Ticket {
  state: 'queued' | 'admitted' | 'waiting'
  readonly admitted: Promise<void>
  readonly admit: () => void
  wake: ((retry: boolean) => void) | undefined
}

/** One per tab. The allowance it learns is the origin's, shared with every other tab of the app and every socket the app opens itself. */
export function createFetchGate (): FetchRouteGate {
  const tickets = new Map<number, Ticket>()
  const queue: number[] = []
  /** Tickets whose dial was refused with 'limit', oldest first. */
  const waiting: number[] = []
  /** Admitted tickets not waiting: the requests whose finishing frees a socket. */
  let live = 0
  /** How many may be live at once, learned from the last 'limit' refusal. */
  let ceiling = Infinity
  let nextTicket = 1

  function wake (id: number, retry: boolean): void {
    const ticket = tickets.get(id)
    if (ticket === undefined) return
    ticket.state = 'admitted'
    live++
    ticket.wake?.(retry)
    ticket.wake = undefined
  }

  function settle (): void {
    // Nothing live means no socket of ours will ever close to wake a waiter.
    if (live === 0) while (waiting.length > 0) wake(waiting.shift() as number, false)
    // Idle: whatever held the allowance may have let go, so learn it afresh.
    if (live === 0 && waiting.length === 0) ceiling = Infinity
    while (queue.length > 0 && live < ceiling) {
      const ticket = tickets.get(queue.shift() as number)
      if (ticket === undefined) continue
      ticket.state = 'admitted'
      live++
      ticket.admit()
    }
  }

  return {
    enqueue () {
      const id = nextTicket++
      let admit!: () => void
      const admitted = new Promise<void>((resolve) => { admit = resolve })
      tickets.set(id, { state: 'queued', admitted, admit, wake: undefined })
      queue.push(id)
      settle()
      return id
    },

    async admitted (id) {
      await (tickets.get(id)?.admitted ?? new Promise<void>(() => {}))
    },

    async afterLimit (id) {
      const ticket = tickets.get(id)
      if (ticket === undefined || ticket.state !== 'admitted') return false
      ticket.state = 'waiting'
      live--
      ceiling = Math.min(ceiling, live)
      const retry = new Promise<boolean>((resolve) => { ticket.wake = resolve })
      waiting.push(id)
      settle()
      return await retry
    },

    release (id) {
      const ticket = tickets.get(id)
      if (ticket === undefined) return
      tickets.delete(id)
      if (ticket.state === 'queued') {
        queue.splice(queue.indexOf(id), 1)
        return
      }
      if (ticket.state === 'waiting') {
        waiting.splice(waiting.indexOf(id), 1)
      } else {
        live--
        // The socket this request just closed goes to one that is already
        // waiting for it, before any queued request is admitted to dial.
        const next = waiting.shift()
        if (next !== undefined) wake(next, true)
      }
      settle()
    }
  }
}
