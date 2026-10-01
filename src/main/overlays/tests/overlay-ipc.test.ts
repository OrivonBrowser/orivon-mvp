import { beforeEach, describe, expect, it, vi } from 'vitest'
import { OVERLAY_COMMAND_CHANNEL } from '../../channels.js'
import { registerOverlayIpc } from '../overlay-ipc.js'
import type { OverlayPort } from '../overlay-ipc.js'

const URL = 'file:///out/renderer/overlay/index.html?overlay=demo&surface=panel'

type Handler = (event: unknown, message: unknown) => Promise<unknown>

function setup (): { call: (message: unknown, frame?: { url: string } | null) => Promise<unknown>, port: OverlayPort, mainFrame: { url: string }, channel: () => string | undefined } {
  const mainFrame = { url: URL }
  let handler: Handler | undefined
  let channel: string | undefined
  const contents = { mainFrame, ipc: { handle: (name: string, fn: Handler) => { channel = name; handler = fn } } }
  const port: OverlayPort = { ready: vi.fn(() => ({ shown: false })), request: vi.fn(() => 'answer'), size: vi.fn(), close: vi.fn() }
  registerOverlayIpc(contents as never, URL, port)
  return {
    port, mainFrame, channel: () => channel,
    call: async (message, frame) => await (handler as Handler)({ senderFrame: frame === undefined ? mainFrame : frame }, message)
  }
}

let t: ReturnType<typeof setup>
beforeEach(() => { t = setup() })

describe('registerOverlayIpc: who may speak', () => {
  it('handles the overlay channel on the view itself', () => {
    expect(t.channel()).toBe(OVERLAY_COMMAND_CHANNEL)
  })

  it('answers the main frame at the exact URL', async () => {
    expect(await t.call({ type: 'request', command: 1 })).toBe('answer')
  })

  it('refuses a sender that is not the view\'s main frame, even at the right URL', async () => {
    const other = { url: URL }
    expect(await t.call({ type: 'request', command: 1 }, other)).toBeUndefined()
    expect(t.port.request).not.toHaveBeenCalled()
  })

  it('refuses the main frame when it sits at another URL', async () => {
    t.mainFrame.url = 'https://evil.example/'
    for (const message of [{ type: 'ready' }, { type: 'request', command: 1 }, { type: 'size', height: 200 }, { type: 'close' }]) {
      expect(await t.call(message)).toBeUndefined()
    }
    expect(t.port.ready).not.toHaveBeenCalled()
    expect(t.port.request).not.toHaveBeenCalled()
    expect(t.port.size).not.toHaveBeenCalled()
    expect(t.port.close).not.toHaveBeenCalled()
  })

  it('refuses the same page with a different query', async () => {
    t.mainFrame.url = URL.replace('overlay=demo', 'overlay=other')
    expect(await t.call({ type: 'request', command: 1 })).toBeUndefined()
  })

  it('refuses a call with no sender frame', async () => {
    expect(await t.call({ type: 'ready' }, null)).toBeUndefined()
    expect(t.port.ready).not.toHaveBeenCalled()
  })
})

describe('registerOverlayIpc: what it accepts', () => {
  it('ready answers with the host\'s reply', async () => {
    expect(await t.call({ type: 'ready' })).toEqual({ shown: false })
  })

  it('forwards the command untouched to the host', async () => {
    await t.call({ type: 'request', command: { id: 'x' } })
    expect(t.port.request).toHaveBeenCalledWith({ id: 'x' })
  })

  it('returns nothing when a request throws, instead of the error', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => {})
    vi.mocked(t.port.request).mockImplementation(() => { throw new Error('secret path /home/x') })
    expect(await t.call({ type: 'request', command: 1 })).toBeUndefined()
  })

  it('returns nothing when a request rejects', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => {})
    vi.mocked(t.port.request).mockRejectedValue(new Error('no'))
    expect(await t.call({ type: 'request', command: 1 })).toBeUndefined()
  })

  it('passes a finite size', async () => {
    await t.call({ type: 'size', height: 240.5 })
    expect(t.port.size).toHaveBeenCalledWith(240.5)
  })

  it.each([Number.NaN, Number.POSITIVE_INFINITY, Number.NEGATIVE_INFINITY, '200', null, undefined, {}])('ignores a size of %s', async (height) => {
    await t.call({ type: 'size', height })
    expect(t.port.size).not.toHaveBeenCalled()
  })

  it('reads escape as escape and anything else as a request', async () => {
    await t.call({ type: 'close', reason: 'escape' })
    await t.call({ type: 'close', reason: 'blur' })
    await t.call({ type: 'close' })
    expect(vi.mocked(t.port.close).mock.calls).toEqual([['escape'], ['request'], ['request']])
  })

  it.each([null, undefined, 'ready', 5, [], {}, { type: 'nope' }, { type: 7 }])('ignores a malformed message %j', async (message) => {
    expect(await t.call(message)).toBeUndefined()
    expect(t.port.ready).not.toHaveBeenCalled()
    expect(t.port.request).not.toHaveBeenCalled()
  })
})
