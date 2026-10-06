import { describe, expect, it, vi } from 'vitest'
import { createDisplayTickets, EARLY_SLACK_MS, QUIET_WINDOW_MS, SUSPECT_MS, TICKET_TIMEOUT_MS, ticketKey } from '../display-tickets.js'

interface Timer { at: number, run: () => void, live: boolean }

/** A clock the test advances by hand, and the timers that fire as it passes them. */
function setup (timerJitterMs = 0, onEnd?: (key: string, nonce: string) => void): { tickets: ReturnType<typeof createDisplayTickets<string>>, advance: (ms: number) => void, nonces: string[] } {
  let now = 0
  const timers: Timer[] = []
  const nonces: string[] = []
  let counter = 0
  const tickets = createDisplayTickets<string>({
    now: () => now,
    setTimer: (run, ms) => { const timer = { at: now + (ms > 1 ? ms - timerJitterMs : ms), run, live: true }; timers.push(timer); return timer },
    clearTimer: (handle) => { (handle as Timer).live = false },
    nonce: () => { const value = `n${++counter}`; nonces.push(value); return value },
    ...(onEnd === undefined ? {} : { onEnd })
  })
  const advance = (ms: number): void => {
    const end = now + ms
    for (;;) {
      const next = timers.filter((timer) => timer.live && timer.at <= end).sort((a, b) => a.at - b.at)[0]
      if (next === undefined) break
      next.live = false
      now = Math.max(now, next.at)
      next.run()
    }
    now = end
  }
  return { tickets, advance, nonces }
}

const KEY = ticketKey(1, 10, 2)
const OTHER = ticketKey(2, 10, 2)

/** Reads a promise without waiting on it: pending until a few turns of the event loop have shown otherwise. */
async function state (promise: Promise<boolean>): Promise<'pending' | boolean> {
  let value: 'pending' | boolean = 'pending'
  void promise.then((granted) => { value = granted })
  await new Promise<void>((resolve) => { setImmediate(resolve) })
  return value
}

describe('display tickets', () => {
  it('refuses a request at once when no ticket is open', async () => {
    const { tickets } = setup()
    expect(await state(tickets.request(KEY))).toBe(false)
  })

  it('refuses a request from a frame that holds no ticket while another frame holds one', async () => {
    const { tickets } = setup()
    tickets.open(KEY, 'screen')
    expect(await state(tickets.request(OTHER))).toBe(false)
    expect(tickets.has(KEY)).toBe(true)
  })

  it('opens a ticket with a fresh nonce each time', () => {
    const { tickets } = setup()
    expect(tickets.open(KEY, 'a')).not.toBe(tickets.open(KEY, 'b'))
  })

  it('allows exactly one request once armed and called, after the quiet window, and hands the choice to the display handler once', async () => {
    const { tickets, advance } = setup()
    const nonce = tickets.open(KEY, 'screen')
    tickets.arm(KEY, nonce)
    const held = tickets.request(KEY)
    tickets.called(KEY, nonce, false)
    expect(await state(held)).toBe('pending')
    advance(QUIET_WINDOW_MS - 1)
    expect(await state(held)).toBe('pending')
    advance(1)
    expect(await state(held)).toBe(true)
    expect(tickets.consumeDisplay(KEY)).toEqual({ choice: 'screen', nonce })
    expect(tickets.consumeDisplay(KEY)).toBeUndefined()
  })

  it('holds a request that arrives after the arm and called messages, and waits the quiet window from its arrival', async () => {
    const { tickets, advance } = setup()
    const nonce = tickets.open(KEY, 'screen')
    tickets.arm(KEY, nonce)
    tickets.called(KEY, nonce, false)
    advance(1000)
    const held = tickets.request(KEY)
    advance(QUIET_WINDOW_MS - 1)
    expect(await state(held)).toBe('pending')
    advance(1)
    expect(await state(held)).toBe(true)
  })

  it('gives the display handler nothing before a request was allowed', async () => {
    const { tickets } = setup()
    tickets.open(KEY, 'screen')
    expect(tickets.consumeDisplay(KEY)).toBeUndefined()
    expect(tickets.has(KEY)).toBe(true)
  })

  it('never allows without the called message', async () => {
    const { tickets, advance } = setup()
    const nonce = tickets.open(KEY, 'screen')
    tickets.arm(KEY, nonce)
    const held = tickets.request(KEY)
    advance(QUIET_WINDOW_MS * 3)
    expect(await state(held)).toBe('pending')
  })

  it('never allows without the arm message, and a called message with no arm voids the ticket', async () => {
    const { tickets, advance } = setup()
    const nonce = tickets.open(KEY, 'screen')
    const held = tickets.request(KEY)
    tickets.called(KEY, nonce, false)
    advance(QUIET_WINDOW_MS * 3)
    expect(await state(held)).toBe(false)
    expect(tickets.has(KEY)).toBe(false)
  })

  it('denies every held request and voids the ticket when a second request arrives', async () => {
    const { tickets, advance } = setup()
    const nonce = tickets.open(KEY, 'screen')
    tickets.arm(KEY, nonce)
    tickets.called(KEY, nonce, false)
    const first = tickets.request(KEY)
    advance(QUIET_WINDOW_MS - 1)
    const second = tickets.request(KEY)
    expect(await state(first)).toBe(false)
    expect(await state(second)).toBe(false)
    expect(tickets.has(KEY)).toBe(false)
    advance(QUIET_WINDOW_MS * 2)
    expect(tickets.consumeDisplay(KEY)).toBeUndefined()
  })

  it('denies a legacy call that arrives before the real one, held together with it', async () => {
    const { tickets } = setup()
    const nonce = tickets.open(KEY, 'screen')
    tickets.arm(KEY, nonce)
    const legacy = tickets.request(KEY)
    const real = tickets.request(KEY)
    tickets.called(KEY, nonce, false)
    expect(await state(legacy)).toBe(false)
    expect(await state(real)).toBe(false)
  })

  it('voids an allowed ticket when another request arrives before the display handler took it', async () => {
    const { tickets, advance } = setup()
    const nonce = tickets.open(KEY, 'screen')
    tickets.arm(KEY, nonce)
    const first = tickets.request(KEY)
    tickets.called(KEY, nonce, false)
    advance(QUIET_WINDOW_MS)
    expect(await state(first)).toBe(true)
    expect(await state(tickets.request(KEY))).toBe(false)
    expect(tickets.consumeDisplay(KEY)).toBeUndefined()
  })

  it('denies everything held when the preload says its call was rejected early', async () => {
    const { tickets } = setup()
    const nonce = tickets.open(KEY, 'screen')
    tickets.arm(KEY, nonce)
    const held = tickets.request(KEY)
    tickets.called(KEY, nonce, true)
    expect(await state(held)).toBe(false)
    expect(tickets.has(KEY)).toBe(false)
  })

  it('denies and voids on an arm message with the wrong nonce', async () => {
    const { tickets } = setup()
    tickets.open(KEY, 'screen')
    const held = tickets.request(KEY)
    tickets.arm(KEY, 'guess')
    expect(await state(held)).toBe(false)
    expect(tickets.has(KEY)).toBe(false)
  })

  it('denies and voids on a called message with the wrong nonce', async () => {
    const { tickets } = setup()
    const nonce = tickets.open(KEY, 'screen')
    tickets.arm(KEY, nonce)
    const held = tickets.request(KEY)
    tickets.called(KEY, 'guess', false)
    expect(await state(held)).toBe(false)
    expect(tickets.has(KEY)).toBe(false)
  })

  it('ignores an arm or called message for a frame with no ticket', () => {
    const { tickets } = setup()
    tickets.arm(KEY, 'n1')
    tickets.called(KEY, 'n1', false)
    expect(tickets.has(KEY)).toBe(false)
  })

  it('denies the held request when the frame is voided, and the display handler then gets nothing', async () => {
    const { tickets } = setup()
    const nonce = tickets.open(KEY, 'screen')
    tickets.arm(KEY, nonce)
    const held = tickets.request(KEY)
    tickets.called(KEY, nonce, false)
    tickets.void(KEY)
    expect(await state(held)).toBe(false)
    expect(tickets.consumeDisplay(KEY)).toBeUndefined()
  })

  it('voids an allowed ticket that the display handler has not consumed', async () => {
    const { tickets, advance } = setup()
    const nonce = tickets.open(KEY, 'screen')
    tickets.arm(KEY, nonce)
    const held = tickets.request(KEY)
    tickets.called(KEY, nonce, false)
    advance(QUIET_WINDOW_MS)
    expect(await state(held)).toBe(true)
    expect(tickets.awaitingDisplay(KEY)).toBe(true)
    tickets.void(KEY)
    expect(tickets.awaitingDisplay(KEY)).toBe(false)
    expect(tickets.consumeDisplay(KEY)).toBeUndefined()
  })

  it('does not report a consumed ticket as waiting for the display handler', async () => {
    const { tickets, advance } = setup()
    const nonce = tickets.open(KEY, 'screen')
    const held = tickets.request(KEY)
    tickets.arm(KEY, nonce)
    tickets.called(KEY, nonce, false)
    advance(QUIET_WINDOW_MS)
    await held
    tickets.consumeDisplay(KEY)
    expect(tickets.awaitingDisplay(KEY)).toBe(false)
  })

  it('voids a ticket that is not used within the timeout and denies what it held', async () => {
    const { tickets, advance } = setup()
    const nonce = tickets.open(KEY, 'screen')
    tickets.arm(KEY, nonce)
    const held = tickets.request(KEY)
    advance(TICKET_TIMEOUT_MS - 1)
    expect(await state(held)).toBe('pending')
    advance(1)
    expect(await state(held)).toBe(false)
    expect(tickets.has(KEY)).toBe(false)
  })

  it('opening a ticket again voids the older one: its held request is denied and its nonce is dead', async () => {
    const { tickets, advance } = setup()
    const old = tickets.open(KEY, 'old')
    const held = tickets.request(KEY)
    const fresh = tickets.open(KEY, 'fresh')
    expect(await state(held)).toBe(false)
    tickets.arm(KEY, old)
    expect(tickets.has(KEY)).toBe(false)
    const again = tickets.open(KEY, 'fresh')
    expect(again).not.toBe(fresh)
    tickets.arm(KEY, again)
    const next = tickets.request(KEY)
    tickets.called(KEY, again, false)
    advance(QUIET_WINDOW_MS)
    expect(await state(next)).toBe(true)
    expect(tickets.consumeDisplay(KEY)?.choice).toBe('fresh')
  })

  it('keeps one frame\'s ticket apart from another\'s', async () => {
    const { tickets, advance } = setup()
    const a = tickets.open(KEY, 'a')
    const b = tickets.open(OTHER, 'b')
    tickets.arm(KEY, a)
    const heldA = tickets.request(KEY)
    tickets.called(KEY, a, false)
    tickets.arm(OTHER, a)
    advance(QUIET_WINDOW_MS)
    expect(await state(heldA)).toBe(true)
    expect(tickets.has(OTHER)).toBe(false)
    expect(b).not.toBe(a)
  })

  it('stops its timers when a ticket ends', () => {
    const { tickets, advance } = setup()
    tickets.open(KEY, 'screen')
    tickets.void(KEY)
    advance(TICKET_TIMEOUT_MS * 2)
    expect(tickets.has(KEY)).toBe(false)
  })

  it('allows a request that overtook the arm message within the slack, after the quiet window that follows called', async () => {
    const { tickets, advance } = setup()
    const nonce = tickets.open(KEY, 'screen')
    const held = tickets.request(KEY)
    advance(EARLY_SLACK_MS - 20)
    tickets.arm(KEY, nonce)
    tickets.called(KEY, nonce, false)
    advance(QUIET_WINDOW_MS - 1)
    expect(await state(held)).toBe('pending')
    advance(1)
    expect(await state(held)).toBe(true)
    expect(tickets.consumeDisplay(KEY)?.choice).toBe('screen')
  })

  it('allows a request that overtook the arm message by exactly the slack', async () => {
    const { tickets, advance } = setup()
    const nonce = tickets.open(KEY, 'screen')
    const held = tickets.request(KEY)
    advance(EARLY_SLACK_MS)
    tickets.arm(KEY, nonce)
    tickets.called(KEY, nonce, false)
    advance(QUIET_WINDOW_MS)
    expect(await state(held)).toBe(true)
  })

  it('denies a request that arrived more than the slack before the arm message, and voids the ticket', async () => {
    const { tickets, advance } = setup()
    const nonce = tickets.open(KEY, 'screen')
    const early = tickets.request(KEY)
    advance(EARLY_SLACK_MS + 1)
    tickets.arm(KEY, nonce)
    tickets.called(KEY, nonce, false)
    advance(QUIET_WINDOW_MS * 2)
    expect(await state(early)).toBe(false)
    expect(tickets.has(KEY)).toBe(false)
    expect(tickets.consumeDisplay(KEY)).toBeUndefined()
  })

  it('denies both when a second request follows one that overtook the arm message within the slack', async () => {
    const { tickets, advance } = setup()
    const nonce = tickets.open(KEY, 'screen')
    const first = tickets.request(KEY)
    advance(10)
    tickets.arm(KEY, nonce)
    const second = tickets.request(KEY)
    tickets.called(KEY, nonce, false)
    advance(QUIET_WINDOW_MS * 2)
    expect(await state(first)).toBe(false)
    expect(await state(second)).toBe(false)
    expect(tickets.has(KEY)).toBe(false)
  })

  it('voids a ticket that was never armed at the timeout, and denies the early request it held', async () => {
    const { tickets, advance } = setup()
    tickets.open(KEY, 'screen')
    const early = tickets.request(KEY)
    advance(TICKET_TIMEOUT_MS - 1)
    expect(await state(early)).toBe('pending')
    advance(1)
    expect(await state(early)).toBe(false)
    expect(tickets.has(KEY)).toBe(false)
  })

  it('does not let a legacy request sent before the preload\'s step ride a late go: the page stalls its thread, then the call and both messages come', async () => {
    const { tickets, advance } = setup()
    const nonce = tickets.open(KEY, 'screen')
    const legacy = tickets.request(KEY)
    advance(QUIET_WINDOW_MS + 50)
    tickets.arm(KEY, nonce)
    tickets.called(KEY, nonce, false)
    const own = tickets.request(KEY)
    advance(QUIET_WINDOW_MS * 2)
    expect(await state(legacy)).toBe(false)
    expect(await state(own)).toBe(false)
    expect(tickets.consumeDisplay(KEY)).toBeUndefined()
  })

  it('counts the quiet window from the called message when the held request is older than it', async () => {
    const { tickets, advance } = setup()
    const nonce = tickets.open(KEY, 'screen')
    tickets.arm(KEY, nonce)
    const held = tickets.request(KEY)
    advance(QUIET_WINDOW_MS + 50)
    tickets.called(KEY, nonce, false)
    advance(QUIET_WINDOW_MS - 1)
    expect(await state(held)).toBe('pending')
    advance(1)
    expect(await state(held)).toBe(true)
  })

  it('denies a held request when a second one arrives in the quiet window that follows the called message', async () => {
    const { tickets, advance } = setup()
    const nonce = tickets.open(KEY, 'screen')
    tickets.arm(KEY, nonce)
    const first = tickets.request(KEY)
    advance(QUIET_WINDOW_MS + 50)
    tickets.called(KEY, nonce, false)
    advance(QUIET_WINDOW_MS - 10)
    const second = tickets.request(KEY)
    expect(await state(first)).toBe(false)
    expect(await state(second)).toBe(false)
    expect(tickets.consumeDisplay(KEY)).toBeUndefined()
  })

  it('still allows when its timer fires a moment before the clock reads the end of the quiet window', async () => {
    const { tickets, advance } = setup(1)
    const nonce = tickets.open(KEY, 'screen')
    tickets.arm(KEY, nonce)
    const held = tickets.request(KEY)
    advance(5)
    tickets.called(KEY, nonce, false)
    advance(QUIET_WINDOW_MS + 20)
    expect(await state(held)).toBe(true)
  })

  describe('a request with no ticket', () => {
    it('marks the frame suspect for SUSPECT_MS and no longer', async () => {
      const { tickets, advance } = setup()
      expect(tickets.suspect(KEY)).toBe(false)
      expect(await state(tickets.request(KEY))).toBe(false)
      expect(tickets.suspect(KEY)).toBe(true)
      expect(tickets.suspect(OTHER)).toBe(false)
      advance(SUSPECT_MS - 1)
      expect(tickets.suspect(KEY)).toBe(true)
      advance(1)
      expect(tickets.suspect(KEY)).toBe(false)
    })

    it('refuses a request that follows a served ticket, long after or soon after, and never reports it as more than a refusal', async () => {
      const { tickets, advance } = setup()
      const consume = async (): Promise<void> => {
        const nonce = tickets.open(KEY, 'screen')
        tickets.arm(KEY, nonce)
        const held = tickets.request(KEY)
        tickets.called(KEY, nonce, false)
        advance(QUIET_WINDOW_MS)
        await held
        tickets.consumeDisplay(KEY)
      }
      await consume()
      advance(100)
      expect(await state(tickets.request(KEY))).toBe(false)
      advance(SUSPECT_MS)
      await consume()
      advance(SUSPECT_MS * 3)
      expect(await state(tickets.request(KEY))).toBe(false)
      expect(tickets.suspect(KEY)).toBe(true)
    })

    it('forgets the suspicion of every frame of a tab when a new document commits there, and no other tab\'s', async () => {
      const { tickets } = setup()
      await tickets.request(KEY)
      await tickets.request(OTHER)
      expect(tickets.suspect(KEY)).toBe(true)
      tickets.forgetTab(1)
      expect(tickets.suspect(KEY)).toBe(false)
      expect(tickets.suspect(OTHER)).toBe(true)
      tickets.forgetTab(22)
      expect(tickets.suspect(OTHER)).toBe(true)
    })

    it('voids a ticket whose request is held while the frame is suspect', async () => {
      const { tickets, advance } = setup()
      await tickets.request(KEY)
      advance(1000)
      const nonce = tickets.open(KEY, 'screen')
      tickets.arm(KEY, nonce)
      const held = tickets.request(KEY)
      tickets.called(KEY, nonce, false)
      advance(QUIET_WINDOW_MS * 2)
      expect(await state(held)).toBe(false)
      expect(tickets.consumeDisplay(KEY)).toBeUndefined()
      expect(tickets.has(KEY)).toBe(false)
    })

    it('lets an honest request through once SUSPECT_MS has passed', async () => {
      const { tickets, advance } = setup()
      await tickets.request(KEY)
      advance(SUSPECT_MS)
      const nonce = tickets.open(KEY, 'screen')
      tickets.arm(KEY, nonce)
      const held = tickets.request(KEY)
      tickets.called(KEY, nonce, false)
      advance(QUIET_WINDOW_MS)
      expect(await state(held)).toBe(true)
    })
  })

  describe('telling the owner of a mark that a ticket ended', () => {
    const arrange = (): ReturnType<typeof setup> & { ended: Array<[string, string]> } => {
      const ended: Array<[string, string]> = []
      return { ...setup(0, (key, nonce) => { ended.push([key, nonce]) }), ended }
    }

    it('reports a ticket the display handler never took: voided, timed out, replaced, refused for two requests or a wrong nonce or the slack', async () => {
      const { tickets, advance, ended } = arrange()
      const voided = tickets.open(KEY, 'a')
      tickets.void(KEY)
      const timedOut = tickets.open(KEY, 'b')
      advance(TICKET_TIMEOUT_MS)
      const replaced = tickets.open(KEY, 'c')
      const fresh = tickets.open(KEY, 'd')
      const wrong = tickets.open(OTHER, 'e')
      tickets.arm(OTHER, 'guess')
      const twice = tickets.open(KEY, 'f')
      tickets.arm(KEY, twice)
      void tickets.request(KEY)
      void tickets.request(KEY)
      const early = tickets.open(OTHER, 'g')
      void tickets.request(OTHER)
      advance(EARLY_SLACK_MS + 1)
      tickets.arm(OTHER, early)
      expect(ended.map(([, nonce]) => nonce)).toEqual([voided, timedOut, replaced, wrong, fresh, twice, early])
      expect(ended[0]?.[0]).toBe(KEY)
    })

    it('reports a ticket voided by suspicion, and one that was allowed and not yet taken', async () => {
      const { tickets, advance, ended } = arrange()
      await tickets.request(KEY)
      const suspected = tickets.open(KEY, 'a')
      tickets.arm(KEY, suspected)
      void tickets.request(KEY)
      expect(ended.map(([, nonce]) => nonce)).toEqual([suspected])
      advance(SUSPECT_MS)
      const allowed = tickets.open(KEY, 'b')
      tickets.arm(KEY, allowed)
      const held = tickets.request(KEY)
      tickets.called(KEY, allowed, false)
      advance(QUIET_WINDOW_MS)
      await held
      await tickets.request(KEY)
      expect(ended.map(([, nonce]) => nonce)).toEqual([suspected, allowed])
    })

    it('does not report a ticket the display handler took: the share starts right after, and starting it clears the mark', async () => {
      const { tickets, advance, ended } = arrange()
      const nonce = tickets.open(KEY, 'screen')
      tickets.arm(KEY, nonce)
      const held = tickets.request(KEY)
      tickets.called(KEY, nonce, false)
      advance(QUIET_WINDOW_MS)
      await held
      expect(tickets.consumeDisplay(KEY)).toEqual({ choice: 'screen', nonce })
      expect(ended).toEqual([])
    })
  })

  describe('voiding every ticket that was allowed and not yet taken', () => {
    it('voids an allowed ticket and leaves an open one', async () => {
      const { tickets, advance } = setup()
      const nonce = tickets.open(KEY, 'screen')
      tickets.arm(KEY, nonce)
      const held = tickets.request(KEY)
      tickets.called(KEY, nonce, false)
      advance(QUIET_WINDOW_MS)
      await held
      tickets.open(OTHER, 'open')
      tickets.voidAllowed()
      expect(tickets.awaitingDisplay(KEY)).toBe(false)
      expect(tickets.consumeDisplay(KEY)).toBeUndefined()
      expect(tickets.has(OTHER)).toBe(true)
    })
  })
})
