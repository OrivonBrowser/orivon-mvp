import { describe, expect, it, vi } from 'vitest'
import type { NetworksSource } from '../../networks/networks-source.js'
import type { NetworksView } from '../../networks/networks-view.js'

// The popup's own channel: the view and the switch reach the one source, only from the popup's own frame at the
// address it was created at, and nothing is pushed once the cleanup has run.

const handlers = new Map<string, (event: unknown, command: unknown) => unknown>()

const { registerNetworksIpc, REFRESH_MS } = await import('../networks-ipc.js')
const { NETWORKS_CHANGED_CHANNEL, NETWORKS_COMMAND_CHANNEL } = await import('../../channels.js')

const PANEL_URL = 'app://orivon/networks/index.html'
const PANEL_FRAME = { url: PANEL_URL }
const OTHER_FRAME = { url: PANEL_URL }
const VIEW: NetworksView = { cards: [], dot: 'none' }

function panelContents (send = vi.fn(), destroyed = false): import('electron').WebContents {
  return { mainFrame: PANEL_FRAME, isDestroyed: () => destroyed, send, ipc: { handle: (channel: string, fn: (event: unknown, command: unknown) => unknown) => { handlers.set(channel, fn) } } } as unknown as import('electron').WebContents
}

function fakeSource (overrides: Partial<NetworksSource> = {}): NetworksSource {
  return { view: vi.fn(() => VIEW), dot: vi.fn(() => 'none' as const), setSwitch: vi.fn(() => true), onChange: vi.fn(() => () => {}), ...overrides }
}

const noTimers = { every: () => () => {} }

function dispatch (command: unknown, senderFrame: unknown = PANEL_FRAME): unknown {
  const fn = handlers.get(NETWORKS_COMMAND_CHANNEL)
  if (fn === undefined) throw new Error('registerNetworksIpc did not register a handler')
  return fn({ senderFrame }, command)
}

describe('registerNetworksIpc', () => {
  it('answers view with the cards, and setSwitch by moving the switch and saying whether it moved', async () => {
    const source = fakeSource()
    registerNetworksIpc(panelContents(), PANEL_URL, source, () => {}, () => {}, noTimers)
    expect(await dispatch({ type: 'view' })).toEqual(VIEW)
    expect(await dispatch({ type: 'setSwitch', id: 'ipfs', on: false })).toBe(true)
    expect(source.setSwitch).toHaveBeenCalledWith('ipfs', false)
  })

  it('refuses every command from a frame that is not the popup\'s own, and from a null frame', async () => {
    const source = fakeSource()
    registerNetworksIpc(panelContents(), PANEL_URL, source, () => {}, () => {}, noTimers)
    for (const frame of [OTHER_FRAME, null]) {
      expect(await dispatch({ type: 'view' }, frame)).toBeUndefined()
      expect(await dispatch({ type: 'setSwitch', id: 'ipfs', on: false }, frame)).toBeUndefined()
    }
    expect(source.view).not.toHaveBeenCalled()
    expect(source.setSwitch).not.toHaveBeenCalled()
  })

  it('refuses a command from the popup\'s own frame once its committed URL is no longer the popup\'s', async () => {
    const source = fakeSource()
    registerNetworksIpc(panelContents(), PANEL_URL, source, () => {}, () => {}, noTimers)
    PANEL_FRAME.url = 'https://attacker.example/'
    try {
      expect(await dispatch({ type: 'setSwitch', id: 'nym', on: false })).toBeUndefined()
      expect(source.setSwitch).not.toHaveBeenCalled()
    } finally {
      PANEL_FRAME.url = PANEL_URL
    }
  })

  it('resizes only to a finite height', async () => {
    const heights = vi.fn()
    registerNetworksIpc(panelContents(), PANEL_URL, fakeSource(), heights, () => {}, noTimers)
    await dispatch({ type: 'contentHeight', height: 300 })
    await dispatch({ type: 'contentHeight', height: Number.NaN })
    await dispatch({ type: 'contentHeight', height: Number.POSITIVE_INFINITY })
    expect(heights.mock.calls).toEqual([[300]])
  })

  it('asks the popup to close after the reply has gone, and only for the popup itself', async () => {
    const close = vi.fn()
    registerNetworksIpc(panelContents(), PANEL_URL, fakeSource(), () => {}, close, noTimers)
    await dispatch({ type: 'close' })
    expect(close).not.toHaveBeenCalled()
    await new Promise((resolve) => { setImmediate(resolve) })
    expect(close).toHaveBeenCalledTimes(1)
    await dispatch({ type: 'close' }, OTHER_FRAME)
    await new Promise((resolve) => { setImmediate(resolve) })
    expect(close).toHaveBeenCalledTimes(1)
  })
})

describe('what is pushed while the popup is open', () => {
  it('sends the cards on every change and every two seconds, and nothing after the cleanup', () => {
    const send = vi.fn()
    let change: (() => void) | undefined
    let tick: (() => void) | undefined
    let period = 0
    const stops = { listener: vi.fn(), timer: vi.fn() }
    const cleanup = registerNetworksIpc(panelContents(send), PANEL_URL, fakeSource({ onChange: (listener) => { change = listener; return stops.listener } }), () => {}, () => {}, { every: (callback, ms) => { tick = callback; period = ms; return stops.timer } })
    expect(period).toBe(REFRESH_MS)
    change?.()
    tick?.()
    expect(send.mock.calls).toEqual([[NETWORKS_CHANGED_CHANNEL, VIEW], [NETWORKS_CHANGED_CHANNEL, VIEW]])
    cleanup()
    expect(stops.listener).toHaveBeenCalledTimes(1)
    expect(stops.timer).toHaveBeenCalledTimes(1)
  })

  it('sends nothing to a popup that is already destroyed', () => {
    const send = vi.fn()
    let tick: (() => void) | undefined
    registerNetworksIpc(panelContents(send, true), PANEL_URL, fakeSource(), () => {}, () => {}, { every: (callback) => { tick = callback; return () => {} } })
    tick?.()
    expect(send).not.toHaveBeenCalled()
  })
})
