import { describe, expect, it } from 'vitest'
import { HidApprovals } from '../hid-approvals.js'
import { forgetDevicesWhenGrantEnds } from '../hid-grant-watch.js'

const APP = 'https://wallet.example'
const SITE = 'https://shop.example'
const NANO = { vendorId: 0x2c97, productId: 0x4011, serialNumber: '0001', name: 'Nano X' }

function setup (state: { live?: boolean, registered?: boolean, persisted?: boolean | 'record-only', patterns?: string[] } = {}) {
  const approvals = new HidApprovals(null)
  approvals.approve(APP, NANO)
  approvals.approve(SITE, NANO)
  let fire: (origin: string) => void = () => {}
  const status = { live: state.live ?? true, registered: state.registered ?? true, persisted: state.persisted ?? true, patterns: state.patterns ?? ['vendor=2c97'] }
  forgetDevicesWhenGrantEnds({
    onGrantsChanged: (listener) => { fire = listener; return () => {} },
    app: {
      heldSync: (_origin, capability) => capability === 'devices.hid' && status.live,
      grantedPatternsSync: (_origin, capability) => capability === 'devices.hid' && status.live ? status.patterns : undefined,
      isRegisteredSync: () => status.registered,
      persistedAppsSync: () => status.persisted === false
        ? []
        : [{ origin: APP, appName: 'Wallet', grants: status.persisted === true ? { 'devices.hid': { patterns: status.patterns, grantedAt: 0 } } : {}, pickedPaths: {} }]
    }
  }, approvals)
  return { approvals, status, fire: (origin: string) => { fire(origin) } }
}

describe('forgetDevicesWhenGrantEnds', () => {
  it('keeps an app\'s devices while it holds the grant', () => {
    const { approvals, fire } = setup()
    fire(APP)
    expect(approvals.list(APP)).toHaveLength(1)
  })

  it('forgets every device of an app once the grant is gone live and on disk', () => {
    const { approvals, status, fire } = setup()
    status.live = false
    status.persisted = 'record-only'
    fire(APP)
    expect(approvals.list(APP)).toEqual([])
  })

  it('forgets them for an app that was not opened this session, revoked through its record', () => {
    const { approvals, status, fire } = setup({ registered: false })
    status.live = false
    status.persisted = 'record-only'
    fire(APP)
    expect(approvals.list(APP)).toEqual([])
  })

  it('does not forget while either side still shows the grant', () => {
    const live = setup({ live: true, persisted: 'record-only' })
    live.fire(APP)
    expect(live.approvals.list(APP)).toHaveLength(1)
    const disk = setup({ live: false, registered: false, persisted: true })
    disk.fire(APP)
    expect(disk.approvals.list(APP)).toHaveLength(1)
  })

  it('keeps only the devices a replaced grant still matches', () => {
    const { approvals, status, fire } = setup()
    approvals.approve(APP, { vendorId: 0x046d, productId: 1, name: 'Mouse' })
    status.patterns = ['vendor=2c97,product=4012']
    fire(APP)
    expect(approvals.list(APP)).toEqual([])
    status.patterns = ['vendor=2c97']
    approvals.approve(APP, NANO)
    status.patterns = ['vendor=2c97,product=4011,usagePage=ffa0']
    fire(APP)
    expect(approvals.list(APP)).toHaveLength(1)
  })

  it('leaves a website\'s devices alone: it has no grant to lose', () => {
    const { approvals, status, fire } = setup()
    status.live = false
    status.registered = false
    status.persisted = false
    fire(SITE)
    expect(approvals.list(SITE)).toHaveLength(1)
  })
})
