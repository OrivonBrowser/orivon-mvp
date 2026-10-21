import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const bridge = vi.hoisted(() => ({ executeInMainWorld: vi.fn(), on: vi.fn() }))
vi.mock('electron', () => ({
  contextBridge: { executeInMainWorld: bridge.executeInMainWorld },
  ipcRenderer: { on: bridge.on }
}))

const { HID_ANNOUNCE_CHANNEL } = await import('../../main/channels.js')

const setFrame = (main: boolean): void => { Object.defineProperty(process, 'isMainFrame', { value: main, configurable: true }) }

async function install (): Promise<(message: unknown) => void> {
  const { installHidAnnounce } = await import('../hid-announce.js')
  installHidAnnounce()
  const registered = bridge.on.mock.calls.at(-1) as [string, (event: unknown, message: unknown) => void] | undefined
  expect(registered?.[0]).toBe(HID_ANNOUNCE_CHANNEL)
  return (message) => { registered?.[1]({}, message) }
}

beforeEach(() => { vi.resetModules(); bridge.executeInMainWorld.mockClear(); bridge.on.mockClear(); setFrame(true) })
afterEach(() => { Reflect.deleteProperty(process, 'isMainFrame'); vi.unstubAllGlobals() })

describe('installHidAnnounce', () => {
  it('listens only in the top frame', async () => {
    setFrame(false)
    const { installHidAnnounce } = await import('../hid-announce.js')
    installHidAnnounce()
    expect(bridge.on).not.toHaveBeenCalled()
  })

  it('runs the announce closure in the page\'s world with the devices main named, and ignores anything else', async () => {
    const send = await install()
    send({ devices: [[0x1209, 1, 'Test Key'], ['x', 1, 'S'], [1, 2], 'junk'] })
    expect(bridge.executeInMainWorld).toHaveBeenCalledOnce()
    expect((bridge.executeInMainWorld.mock.calls[0]?.[0] as { args: unknown[] }).args).toEqual([[[0x1209, 1, 'Test Key']]])
    bridge.executeInMainWorld.mockClear()
    send(null)
    send({ devices: 'no' })
    send({ devices: [] })
    expect(bridge.executeInMainWorld).not.toHaveBeenCalled()
  })

  describe('the closure that runs in the page\'s world', () => {
    class FakeHidEvent extends Event {
      device: unknown = null
    }

    async function announce (triples: Array<[number, number, string]>, listed: Array<{ vendorId: number, productId: number, productName?: string }>): Promise<Array<{ type: string, device: unknown }>> {
      const target = new EventTarget() as EventTarget & { getDevices: () => Promise<typeof listed> }
      target.getDevices = async () => listed
      const heard: Array<{ type: string, device: unknown }> = []
      target.addEventListener('connect', (event) => { heard.push({ type: event.type, device: (event as FakeHidEvent).device }) })
      vi.stubGlobal('navigator', { hid: target })
      vi.stubGlobal('HIDConnectionEvent', FakeHidEvent)
      const send = await install()
      send({ devices: triples })
      const { func, args } = bridge.executeInMainWorld.mock.calls[0]?.[0] as { func: (...a: unknown[]) => void, args: unknown[] }
      func(...args)
      await new Promise((resolve) => { setImmediate(resolve) })
      return heard
    }

    it('dispatches connect with the same device object getDevices() returned, for a listed device only', async () => {
      const listed = [{ vendorId: 0x1209, productId: 1, productName: 'Test Key' }, { vendorId: 0x1209, productId: 2, productName: 'Other' }]
      const heard = await announce([[0x1209, 1, 'Test Key']], listed)
      expect(heard).toHaveLength(1)
      expect(heard[0]?.device).toBe(listed[0])
    })

    it('announces a device object once, however many times main names it', async () => {
      const listed = [{ vendorId: 0x1209, productId: 1, productName: 'Test Key' }]
      const target = new EventTarget() as EventTarget & { getDevices: () => Promise<typeof listed> }
      target.getDevices = async () => listed
      let heard = 0
      target.addEventListener('connect', () => { heard += 1 })
      vi.stubGlobal('navigator', { hid: target })
      vi.stubGlobal('HIDConnectionEvent', FakeHidEvent)
      const send = await install()
      for (let round = 0; round < 2; round += 1) {
        send({ devices: [[0x1209, 1, 'Test Key']] })
        const { func, args } = bridge.executeInMainWorld.mock.calls[round]?.[0] as { func: (...a: unknown[]) => void, args: unknown[] }
        func(...args)
        await new Promise((resolve) => { setImmediate(resolve) })
      }
      expect(heard).toBe(1)
    })

    it('announces nothing for a device the page\'s own getDevices() does not list', async () => {
      expect(await announce([[0x1209, 1, 'Test Key']], [])).toEqual([])
    })

    it('treats a missing product name as the empty string', async () => {
      const listed = [{ vendorId: 5, productId: 6 }]
      expect(await announce([[5, 6, '']], listed)).toHaveLength(1)
    })

    it('does nothing on a page without WebHID', async () => {
      vi.stubGlobal('navigator', {})
      const send = await install()
      send({ devices: [[1, 2, '']] })
      const { func, args } = bridge.executeInMainWorld.mock.calls[0]?.[0] as { func: (...a: unknown[]) => void, args: unknown[] }
      expect(() => { func(...args) }).not.toThrow()
    })
  })
})
