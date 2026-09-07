import { describe, expect, it, vi } from 'vitest'
import { deliverPort } from '../deliver-port.js'
import { PORT_CHANNEL } from '../../../main/channels.js'
import type { PortDeliveryFrame } from '../port-transport.js'

const APP = 'https://app.example'
const OTHER = 'https://other.example'

/** A PortDeliveryFrame whose live origin (re-derived from url+origin, exactly as originFromSenderFrame does) is `origin`. */
function frame (origin: string, postMessage: PortDeliveryFrame['postMessage'] = vi.fn()): PortDeliveryFrame {
  return { url: `${origin}/index.html`, origin, postMessage }
}

/** abandon() always releases and throws, per its own contract -- never resolves. */
function abandonSpy (): (reason: string) => Promise<never> {
  return vi.fn(async (reason: string): Promise<never> => { throw new Error(reason) })
}

describe('deliverPort', () => {
  it('delivers the port when the frame\'s live origin still matches the authorised one', async () => {
    const postMessage = vi.fn()
    const abandon = abandonSpy()

    await deliverPort({ origin: APP, handleId: 'handle-1', frame: frame(APP, postMessage), port2: 'the-port2-value', abandon })

    expect(postMessage).toHaveBeenCalledOnce()
    expect(postMessage).toHaveBeenCalledWith(PORT_CHANNEL, { handleId: 'handle-1' }, ['the-port2-value'])
    expect(abandon).not.toHaveBeenCalled()
  })

  it('abandons, without delivering, when the frame changed origin before delivery', async () => {
    const postMessage = vi.fn()
    const abandon = abandonSpy()
    // Authorised for APP; the live frame has since navigated to OTHER.

    await expect(deliverPort({ origin: APP, handleId: 'handle-1', frame: frame(OTHER, postMessage), port2: 'the-port2-value', abandon }))
      .rejects.toThrow('the calling frame changed origin before its port could be delivered')

    expect(abandon).toHaveBeenCalledOnce()
    expect(abandon).toHaveBeenCalledWith('the calling frame changed origin before its port could be delivered')
    expect(postMessage).not.toHaveBeenCalled()
  })

  it('abandons when there is no live frame to deliver the port to', async () => {
    const abandon = abandonSpy()

    await expect(deliverPort({ origin: APP, handleId: 'handle-1', frame: null, port2: 'the-port2-value', abandon }))
      .rejects.toThrow('no frame to deliver the port to')

    expect(abandon).toHaveBeenCalledOnce()
    expect(abandon).toHaveBeenCalledWith('no frame to deliver the port to')
  })

  it('abandons when the frame went away between the origin check and the postMessage call', async () => {
    const postMessage = vi.fn(() => { throw new Error('Object has been destroyed') })
    const abandon = abandonSpy()

    await expect(deliverPort({ origin: APP, handleId: 'handle-1', frame: frame(APP, postMessage), port2: 'the-port2-value', abandon }))
      .rejects.toThrow('the calling frame went away before its port could be delivered')

    expect(abandon).toHaveBeenCalledOnce()
    expect(abandon).toHaveBeenCalledWith('the calling frame went away before its port could be delivered')
  })
})
