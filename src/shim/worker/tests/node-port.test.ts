// Findings from the natives review: a port inside workerData needs wrapping the same way a
// message payload's does, and NodeMessagePort's DOM-style surface (addEventListener, the
// onmessage/onmessageerror attributes, the `{ transfer }` postMessage form, prependListener, and
// 'close' propagating from the other twin) matches what Node's own worker_threads.MessagePort
// does, measured directly against Node's global MessagePort/MessageChannel.

import { describe, expect, it } from 'vitest'
import { mapOneLevel, wrapPort, wrapPorts } from '../node-port.js'

describe('wrapPorts', () => {
  it('wraps a raw MessagePort found one level deep, so workerData gets the same treatment a message payload already does', () => {
    const { port1, port2 } = new MessageChannel()
    const wrapped = wrapPorts({ port: port2, other: 1 }) as { port: { on: unknown, postMessage: unknown }, other: number }
    expect(typeof wrapped.port.on).toBe('function')
    expect(typeof wrapped.port.postMessage).toBe('function')
    expect(wrapped.other).toBe(1)
    port1.close()
  })

  it('wraps a bare port value itself, not only one nested in an object', () => {
    const { port1, port2 } = new MessageChannel()
    const wrapped = wrapPorts(port2) as { on: unknown }
    expect(typeof wrapped.on).toBe('function')
    port1.close()
  })

  it('leaves a value with no port untouched', () => {
    expect(wrapPorts({ text: 'hi' })).toEqual({ text: 'hi' })
    expect(wrapPorts(undefined)).toBeUndefined()
  })
})

describe('NodeMessagePort', () => {
  it('accepts postMessage\'s { transfer } option form, not only a bare transferList array, as Node does', async () => {
    const { port1, port2 } = new MessageChannel()
    const a = wrapPort(port1)
    const b = wrapPort(port2)
    const { port1: extraLocal, port2: extraRemote } = new MessageChannel()
    const received = new Promise((resolve) => { b.once('message', resolve) })
    a.postMessage({ extra: extraRemote }, { transfer: [extraRemote] })
    const value = await received as { extra: { postMessage: unknown } }
    expect(typeof value.extra.postMessage).toBe('function')
    extraLocal.close()
    a.close()
  })

  it('delivers a real MessageEvent to addEventListener and to the onmessage attribute, and either one starts the port on its own', async () => {
    const { port1, port2 } = new MessageChannel()
    const a = wrapPort(port1)
    const b = wrapPort(port2)
    const viaAddEventListener = new Promise<unknown>((resolve) => {
      b.addEventListener('message', (event) => { resolve((event as MessageEvent).data) })
    })
    a.postMessage('via addEventListener')
    expect(await viaAddEventListener).toBe('via addEventListener')

    const { port1: p1, port2: p2 } = new MessageChannel()
    const c = wrapPort(p1)
    const d = wrapPort(p2)
    const viaOnmessage = new Promise<unknown>((resolve) => {
      // Node's own thread bug this reproduces: assigning onmessage alone, with no other listener
      // and no explicit start(), must still start delivery.
      d.onmessage = (event) => { resolve((event as MessageEvent).data) }
    })
    c.postMessage('via onmessage')
    expect(await viaOnmessage).toBe('via onmessage')
    a.close()
    c.close()
  })

  it('removes the onmessage attribute\'s own listener when reassigned or cleared, without touching an unrelated on() listener', async () => {
    const { port1, port2 } = new MessageChannel()
    const a = wrapPort(port1)
    const b = wrapPort(port2)
    const seenViaOn: unknown[] = []
    b.on('message', (value: unknown) => seenViaOn.push(value))
    let seenViaAttr: unknown
    b.onmessage = (event) => { seenViaAttr = (event as MessageEvent).data }
    b.onmessage = null
    a.postMessage('after clearing onmessage')
    await new Promise((resolve) => setTimeout(resolve, 20))
    expect(seenViaOn).toEqual(['after clearing onmessage'])
    expect(seenViaAttr).toBeUndefined()
    a.close()
  })

  it('starts the port from prependListener, not only on()/once()/the onmessage attribute', async () => {
    const { port1, port2 } = new MessageChannel()
    const a = wrapPort(port1)
    const b = wrapPort(port2)
    const received = new Promise((resolve) => { b.prependListener('message', resolve) })
    a.postMessage('via prependListener')
    expect(await received).toBe('via prependListener')
    a.close()
  })

  it('fires \'close\' on a port when the OTHER twin closes, not only on its own close()', async () => {
    const { port1, port2 } = new MessageChannel()
    const a = wrapPort(port1)
    const b = wrapPort(port2)
    const bClosed = new Promise<void>((resolve) => { b.on('close', resolve) })
    a.close()
    await bClosed
  })
})

describe('mapOneLevel', () => {
  it('is exported for a caller that needs the same one-level traversal wrapPorts/unwrapPorts use', () => {
    expect(mapOneLevel({ a: 1, b: 2 }, (item) => (item === 1 ? 'one' : item))).toEqual({ a: 'one', b: 2 })
  })
})
