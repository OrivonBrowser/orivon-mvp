import { describe, expect, it, vi } from 'vitest'
import { createHidGate } from '../hid-gate.js'
import { handleSelectHidDevice, type HidSelectDeps } from '../hid-select.js'
import { deviceKey } from '../hid-policy.js'
import type { ChooserSpec } from '../../auth/chooser-store.js'

const APP = 'https://wallet.example'
const SITE = 'https://shop.example'
const NANO = { deviceId: '/sys/a', vendorId: 0x2c97, productId: 0x4011, serialNumber: '0001', name: 'Nano X', collections: [] }
const KEY = { deviceId: '/sys/b', vendorId: 0x1209, productId: 0x0001, name: 'Test Key', collections: [] }
const FRAME = { id: 'frame' }

function setup (options: { origin?: string | null, patterns?: readonly string[], blocked?: boolean, full?: boolean, choose?: (spec: ChooserSpec) => string | null } = {}) {
  const approved: Array<[string, string]> = []
  const order: string[] = []
  const gate = createHidGate({
    approvals: { has: () => false },
    isApp: (origin) => origin === APP,
    appPatterns: (origin) => origin === APP ? options.patterns : undefined,
    siteBlocked: () => options.blocked === true,
    requestAsk: () => {}
  })
  const specs: ChooserSpec[] = []
  const deps: HidSelectDeps<typeof FRAME> = {
    gate,
    target: () => options.origin === null ? null : { origin: options.origin ?? APP, ask: async (spec) => { specs.push(spec); return options.choose?.(spec) ?? null } },
    approve: (origin, device) => { approved.push([origin, deviceKey(device)]); order.push('approve'); return options.full !== true }
  }
  const callback = vi.fn((_id?: string | null) => { order.push('callback') })
  const event = { preventDefault: vi.fn() }
  const run = async (list: unknown[] = [NANO, KEY]): Promise<void> => {
    handleSelectHidDevice(deps, event, { deviceList: list, frame: FRAME }, callback)
    await new Promise((resolve) => { setImmediate(resolve) })
  }
  return { run, callback, event, specs, approved, order }
}

describe('handleSelectHidDevice', () => {
  it('takes the event over so Electron does not pick the first device', async () => {
    const { run, event } = setup()
    await run()
    expect(event.preventDefault).toHaveBeenCalledOnce()
  })

  it('cancels at once for a frame that is not a tab\'s top frame', async () => {
    const { run, callback, specs } = setup({ origin: null })
    await run()
    expect(callback).toHaveBeenCalledWith('')
    expect(specs).toEqual([])
  })

  it('opens no chooser for a blocked website or an app without the grant', async () => {
    for (const options of [{ origin: SITE, blocked: true }, { origin: APP }]) {
      const { run, callback, specs } = setup(options)
      await run()
      expect(callback).toHaveBeenCalledWith('')
      expect(specs).toEqual([])
    }
  })

  it('lists an app only the devices its grant matches, and a website all of them', async () => {
    const app = setup({ patterns: ['vendor=2c97'] })
    await app.run()
    expect(app.specs[0]?.items.map((item) => item.title)).toEqual(['Nano X'])
    const site = setup({ origin: SITE })
    await site.run()
    expect(site.specs[0]?.items.map((item) => item.title)).toEqual(['Nano X', 'Test Key'])
  })

  it('opens the chooser even when the app\'s device is not connected, and Cancel cancels the request', async () => {
    const { run, callback, specs } = setup({ patterns: ['vendor=2c97'] })
    await run([KEY])
    expect(specs[0]?.items).toEqual([])
    expect(callback).toHaveBeenCalledWith('')
  })

  it('records the approval before it tells Chromium which device was picked', async () => {
    const { run, callback, approved, order } = setup({ origin: SITE, choose: () => '1' })
    await run()
    expect(callback).toHaveBeenCalledWith('/sys/b')
    expect(approved).toEqual([[SITE, deviceKey({ vendorId: 0x1209, productId: 1, name: 'Test Key' })]])
    expect(order).toEqual(['approve', 'callback'])
  })

  it('cancels the pick when the approval could not be kept, because Chromium would not honour it', async () => {
    const { run, callback } = setup({ origin: SITE, choose: () => '0', full: true })
    await run()
    expect(callback).toHaveBeenCalledWith('')
  })

  it('picks the right device when the grant hid the ones before it', async () => {
    const { run, callback } = setup({ patterns: ['vendor=1209'], choose: () => '0' })
    await run()
    expect(callback).toHaveBeenCalledWith('/sys/b')
  })

  it('ignores a list entry that is not a HID device', async () => {
    const { run, specs } = setup({ origin: SITE })
    await run([NANO, 'junk', null])
    expect(specs[0]?.items).toHaveLength(1)
  })

  it('cancels when the sheet fails', async () => {
    const { run, callback } = setup({ origin: SITE, choose: () => { throw new Error('no sheet') } })
    const quiet = vi.spyOn(console, 'error').mockImplementation(() => {})
    await run()
    expect(callback).toHaveBeenCalledWith('')
    quiet.mockRestore()
  })
})
