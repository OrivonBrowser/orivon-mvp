import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createDisplayAsker } from '../display-asker.js'
import { createDisplayGate } from '../display-gate.js'
import { createDisplayHandler } from '../display-handler.js'
import { createDisplayTickets, QUIET_WINDOW_MS, SUSPECT_MS } from '../display-tickets.js'
import { mainFrameKey } from '../frame-key.js'
import { createShareRegistry } from '../share-registry.js'
import type { DisplayChoice } from '../types.js'

const ORIGIN = 'https://share.example'
const SCREEN: DisplayChoice = { kind: 'screen', source: { id: 'screen:0:0', name: 'Entire screen' }, systemAudio: false, label: 'Entire screen' }
const DISPLAY = { mediaTypes: [], isMainFrame: true, securityOrigin: ORIGIN, requestingUrl: `${ORIGIN}/` }

/** The real tickets, gate, handler, asker and registry over fakes of Electron: what the preload's confirmation does to each. */
function assemble (choice: DisplayChoice = SCREEN): {
  contents: never
  pick: () => Promise<string>
  serve: (nonce: string) => Promise<boolean>
  ticketless: () => Promise<boolean>
  asked: () => Promise<boolean> | undefined
  gate: ReturnType<typeof createDisplayGate>
  registry: ReturnType<typeof createShareRegistry>
  crashed: ReturnType<typeof vi.fn>
  sendStop: ReturnType<typeof vi.fn>
} {
  const frame = { processId: 10, routingId: 2, url: `${ORIGIN}/` }
  const contents = { id: 1, mainFrame: frame, isDestroyed: () => false, getURL: () => `${ORIGIN}/` } as never
  const crashed = vi.fn()
  const sendStop = vi.fn()
  const shares = createShareRegistry({
    now: () => Date.now(),
    newId: (() => { let n = 0; return () => `share-${++n}` })(),
    watch: () => () => {},
    watchTab: () => () => {},
    isBeingCaptured: () => false,
    sendStop,
    markInUse: () => {},
    clearInUse: () => {},
    setTimer: (run, ms) => setTimeout(run, ms),
    clearTimer: (handle) => { clearTimeout(handle as ReturnType<typeof setTimeout>) },
    every: () => () => {}
  })
  const tickets = createDisplayTickets<DisplayChoice>({ onEnd: (_key, nonce) => { shares.cancelExpected(nonce) } })
  const gate = createDisplayGate({
    tickets,
    policy: { isApp: () => false, mayAsk: () => true, decide: async () => await Promise.resolve(true) },
    choose: async () => await Promise.resolve(choice),
    shares,
    isTab: () => true,
    showing: () => true,
    mainFrameOrigin: () => ORIGIN,
    frameKey: mainFrameKey,
    endUnexpectedCapture: crashed
  })
  const handler = createDisplayHandler({ tickets, contentsOf: () => contents, shares, platform: 'linux' })
  const asker = createDisplayAsker({ tickets, isTab: () => true, mainFrameOrigin: () => ORIGIN, mayAsk: () => true, endUnexpectedCapture: crashed })

  return {
    contents,
    gate,
    registry: shares,
    crashed,
    sendStop,
    async pick () {
      const reply = await gate.pick(contents, { audio: false, hints: {}, activation: true })
      if (reply.type !== 'go') throw new Error('the pick was refused')
      return reply.nonce
    },
    // The preload's step for `nonce`, answered the way Electron does: the request, then the handler inside the grant.
    async serve (nonce) {
      gate.arm(contents, nonce)
      const asked = asker.request?.(contents, 'media', DISPLAY)
      gate.called(contents, nonce, false)
      await vi.advanceTimersByTimeAsync(QUIET_WINDOW_MS)
      const granted = await asked
      if (granted === true) {
        handler({ frame, securityOrigin: ORIGIN, videoRequested: true, audioRequested: false, userGesture: true } as never, () => {})
        asker.afterGrant?.(contents, 'media', DISPLAY)
      }
      return granted === true
    },
    asked: () => asker.request?.(contents, 'media', DISPLAY) as Promise<boolean> | undefined,
    async ticketless () {
      return await asker.request?.(contents, 'media', DISPLAY) === true
    }
  }
}

beforeEach(() => { vi.useFakeTimers() })
afterEach(() => { vi.useRealTimers() })

describe('a share the preload confirms or reports failed', () => {
  it('survives a ticketless request after a served and confirmed one, as an extension\'s content script or a ported app\'s callback call makes: refused, no crash, the share still running', async () => {
    const { pick, serve, ticketless, gate, contents, registry, crashed } = assemble()
    const nonce = await pick()
    expect(await serve(nonce)).toBe(true)
    gate.received(contents, nonce)
    await vi.advanceTimersByTimeAsync(1000)
    expect(await ticketless()).toBe(false)
    expect(crashed).not.toHaveBeenCalled()
    expect(registry.list()).toHaveLength(1)
    gate.tracksEnded(contents, nonce)
    expect(registry.list()).toEqual([])
  })

  it('ends the renderer when the preload\'s own call is refused with NotAllowedError, however late: someone else\'s request took the ticket', async () => {
    const { pick, serve, gate, contents, registry, crashed } = assemble()
    const nonce = await pick()
    expect(await serve(nonce)).toBe(true)
    await vi.advanceTimersByTimeAsync(30_000)
    expect(registry.list()).toHaveLength(1)
    gate.failed(contents, nonce, 'NotAllowedError')
    expect(crashed).toHaveBeenCalledOnce()
    expect(registry.list()).toEqual([])
  })

  it.each(['AbortError', 'NotReadableError', 'NotFoundError'] as const)('ends the share and not the renderer when the capture could not start (%s)', async (name) => {
    const { pick, serve, gate, contents, registry, crashed } = assemble()
    const nonce = await pick()
    expect(await serve(nonce)).toBe(true)
    gate.failed(contents, nonce, name)
    expect(crashed).not.toHaveBeenCalled()
    expect(registry.list()).toEqual([])
  })

  it('does not let the tracks ending end an unconfirmed share: a page cannot make the sharing bar disappear', async () => {
    const { pick, serve, gate, contents, registry } = assemble()
    const nonce = await pick()
    expect(await serve(nonce)).toBe(true)
    gate.tracksEnded(contents, nonce)
    await vi.advanceTimersByTimeAsync(SUSPECT_MS * 4)
    expect(registry.list()).toHaveLength(1)
  })

  it('refuses the page\'s own request that outlasts any window, and still ends the renderer when the preload\'s call is refused behind it', async () => {
    const { pick, serve, ticketless, gate, contents, registry, crashed } = assemble()
    const nonce = await pick()
    // The page's request took the ticket; the preload's own call reaches main later, with no ticket.
    expect(await serve(nonce)).toBe(true)
    await vi.advanceTimersByTimeAsync(SUSPECT_MS * 3)
    expect(await ticketless()).toBe(false)
    gate.failed(contents, nonce, 'NotAllowedError')
    expect(crashed).toHaveBeenCalledOnce()
    expect(registry.list()).toEqual([])
  })

  it('does not end the renderer for a refusal of a call that never had a share', async () => {
    const { pick, gate, contents, crashed } = assemble()
    const nonce = await pick()
    gate.failed(contents, nonce, 'NotAllowedError')
    expect(crashed).not.toHaveBeenCalled()
  })

  it('keeps a picked tab attached until the share starts, and lets it go when the ticket ends unused (two requests)', async () => {
    const tab = { id: 2, isDestroyed: () => false, mainFrame: { processId: 11, routingId: 3 } } as never
    const { pick, serve, asked, registry } = assemble({ kind: 'tab', tab, audio: false, label: 'A tab' })
    const kept = await pick()
    expect(registry.capturePending(tab)).toBe(true)
    expect(await serve(kept)).toBe(true)
    expect(registry.capturePending(tab)).toBe(false)

    const lost = await pick()
    expect(registry.capturePending(tab)).toBe(true)
    void asked()
    void asked()
    expect(lost).not.toBe(kept)
    expect(registry.capturePending(tab)).toBe(false)
  })
})
