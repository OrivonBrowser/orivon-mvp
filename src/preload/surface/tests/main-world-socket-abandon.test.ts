// The page's `signal` on orivon.net.connect and connectSecure (ADR-0071): an AbortSignal cannot cross the contextBridge,
// so installOrivon strips it and hands the bridge a function that registers the cancel.

import { describe, expect, it, vi } from 'vitest'
import { installOrivon } from '../main-world-socket.js'
import { LIMITS, asPage, fakeBridge, fakeSocketBridgeResult } from './main-world-socket.test-helpers.js'

type Dial = (opts: unknown) => Promise<unknown>

function pageWith (bridge: ReturnType<typeof fakeBridge>): { connect: Dial, connectSecure: Dial } {
  const target: Record<string, unknown> = {}
  installOrivon(bridge, LIMITS, target)
  return (asPage(target.orivon) as { net: { connect: Dial, connectSecure: Dial } }).net
}

describe.each([['connect', 'netConnect'], ['connectSecure', 'netConnectSecure']] as const)('orivon.net.%s with a signal', (method, bridgeMethod) => {
  it('sends the bridge the options without the signal, and a function that registers the cancel', async () => {
    const bridge = fakeBridge(fakeSocketBridgeResult())
    const seen: Array<{ opts: object, onAbandon: unknown }> = []
    bridge[bridgeMethod] = async (opts, onAbandon) => { seen.push({ opts, onAbandon }); return fakeSocketBridgeResult() }

    await pageWith(bridge)[method]({ host: 'x.example', port: 443, signal: new AbortController().signal })

    expect(seen[0]?.opts).toEqual({ host: 'x.example', port: 443 })
    expect(typeof seen[0]?.onAbandon).toBe('function')
  })

  it('runs the registered cancel when the signal aborts before the call settles', async () => {
    const bridge = fakeBridge(fakeSocketBridgeResult())
    const cancel = vi.fn()
    let finish!: () => void
    bridge[bridgeMethod] = async (_opts, onAbandon) => {
      onAbandon?.(cancel)
      await new Promise<void>((resolve) => { finish = resolve })
      return fakeSocketBridgeResult()
    }
    const controller = new AbortController()
    const pending = pageWith(bridge)[method]({ host: 'x.example', port: 443, signal: controller.signal })
    await vi.waitFor(() => expect(typeof finish).toBe('function'))

    controller.abort()
    finish()
    await pending

    expect(cancel).toHaveBeenCalledOnce()
  })

  it('stops listening once the call settled, so a later abort cancels nothing', async () => {
    const bridge = fakeBridge(fakeSocketBridgeResult())
    const cancel = vi.fn()
    bridge[bridgeMethod] = async (_opts, onAbandon) => { onAbandon?.(cancel); return fakeSocketBridgeResult() }
    const controller = new AbortController()
    await pageWith(bridge)[method]({ host: 'x.example', port: 443, signal: controller.signal })

    controller.abort()

    expect(cancel).not.toHaveBeenCalled()
  })

  it('rejects closed without calling the bridge when the signal is already aborted', async () => {
    const bridge = fakeBridge(fakeSocketBridgeResult())
    const call = vi.fn(async () => fakeSocketBridgeResult())
    bridge[bridgeMethod] = call

    await expect(pageWith(bridge)[method]({ host: 'x.example', port: 443, signal: AbortSignal.abort() })).rejects.toMatchObject({ code: 'closed' })
    expect(call).not.toHaveBeenCalled()
  })

  it('rejects invalid for a signal that is not an AbortSignal', async () => {
    const bridge = fakeBridge(fakeSocketBridgeResult())
    const call = vi.fn(async () => fakeSocketBridgeResult())
    bridge[bridgeMethod] = call

    await expect(pageWith(bridge)[method]({ host: 'x.example', port: 443, signal: {} })).rejects.toMatchObject({ code: 'invalid' })
    expect(call).not.toHaveBeenCalled()
  })

  it('leaves a call without a signal as it was, with no registrar and no signal key', async () => {
    const bridge = fakeBridge(fakeSocketBridgeResult())
    const seen: Array<{ opts: object, onAbandon: unknown }> = []
    bridge[bridgeMethod] = async (opts, onAbandon) => { seen.push({ opts, onAbandon }); return fakeSocketBridgeResult() }

    await pageWith(bridge)[method]({ host: 'x.example', port: 443, signal: undefined })

    expect(seen[0]).toEqual({ opts: { host: 'x.example', port: 443 }, onAbandon: undefined })
  })
})
