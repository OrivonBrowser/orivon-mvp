import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { HidApprovals, parseHidApprovals } from '../hid-approvals.js'
import { deviceKey } from '../hid-policy.js'

const APP = 'https://wallet.example'
const OTHER = 'https://other.example'
const NANO = { vendorId: 0x2c97, productId: 0x4011, serialNumber: '0001', name: 'Nano X' }
const SECOND = { ...NANO, serialNumber: '0002' }

let dir: string | undefined
afterEach(() => { if (dir !== undefined) rmSync(dir, { recursive: true, force: true }); dir = undefined })
const fileIn = (): string => { dir = mkdtempSync(join(tmpdir(), 'hid-approvals-')); return join(dir, 'hid-devices.json') }

describe('HidApprovals', () => {
  it('remembers an approval for the origin and device only', () => {
    const store = new HidApprovals(null, () => 7)
    store.approve(APP, NANO)
    expect(store.has(APP, deviceKey(NANO))).toBe(true)
    expect(store.has(APP, deviceKey(SECOND))).toBe(false)
    expect(store.has(OTHER, deviceKey(NANO))).toBe(false)
    expect(store.list(APP)).toEqual([{ key: deviceKey(NANO), vendorId: 0x2c97, productId: 0x4011, serialNumber: '0001', name: 'Nano X', approvedAt: 7 }])
  })

  it('approving twice keeps one row, and reports a change only the first time', () => {
    const store = new HidApprovals(null)
    const changed = vi.fn()
    store.onChange(changed)
    store.approve(APP, NANO)
    store.approve(APP, NANO)
    expect(store.list(APP)).toHaveLength(1)
    expect(changed).toHaveBeenCalledTimes(1)
    expect(changed).toHaveBeenCalledWith(APP)
  })

  it('forgets one device, then every device of an origin', () => {
    const store = new HidApprovals(null)
    store.approve(APP, NANO)
    store.approve(APP, SECOND)
    store.approve(OTHER, NANO)
    expect(store.forget(APP, deviceKey(NANO))).toBe(true)
    expect(store.forget(APP, deviceKey(NANO))).toBe(false)
    expect(store.has(APP, deviceKey(SECOND))).toBe(true)
    expect(store.forgetOrigin(APP)).toBe(true)
    expect(store.list(APP)).toEqual([])
    expect(store.has(OTHER, deviceKey(NANO))).toBe(true)
    expect(store.forgetOrigin(APP)).toBe(false)
  })

  it('survives a restart for an origin that may be persisted', () => {
    const path = fileIn()
    const first = new HidApprovals(path)
    first.approve(APP, NANO)
    expect(new HidApprovals(path).has(APP, deviceKey(NANO))).toBe(true)
    first.forget(APP, deviceKey(NANO))
    expect(new HidApprovals(path).has(APP, deviceKey(NANO))).toBe(false)
  })

  it('writes nothing for a loopback or plain-http origin', () => {
    const path = fileIn()
    const store = new HidApprovals(path)
    store.approve('http://127.0.0.1:8080', NANO)
    expect(store.has('http://127.0.0.1:8080', deviceKey(NANO))).toBe(true)
    expect(() => readFileSync(path, 'utf8')).toThrow()
  })

  it('keeps a private session in memory', () => {
    const store = new HidApprovals(null)
    store.approve(APP, NANO)
    expect(new HidApprovals(null).has(APP, deviceKey(NANO))).toBe(false)
  })

  it('starts empty from a file it cannot read', () => {
    const path = fileIn()
    writeFileSync(path, '{not json')
    expect(new HidApprovals(path).list(APP)).toEqual([])
  })
})

describe('parseHidApprovals', () => {
  it('keeps only well-formed rows under a canonical origin, with the key it recomputes', () => {
    const raw = JSON.stringify({
      version: 1,
      origins: {
        [APP]: [
          { vendorId: 1, productId: 2, serialNumber: 's', name: 'n', approvedAt: 5, key: 'forged' },
          { vendorId: 'x', productId: 2 },
          { vendorId: 70000, productId: 2 },
          'junk'
        ],
        'https://Wallet.Example/path': [{ vendorId: 1, productId: 2 }]
      }
    })
    const parsed = parseHidApprovals(raw)
    expect([...parsed.keys()]).toEqual([APP])
    expect(parsed.get(APP)).toEqual([{ key: deviceKey({ vendorId: 1, productId: 2, serialNumber: 's', name: 'n' }), vendorId: 1, productId: 2, serialNumber: 's', name: 'n', approvedAt: 5 }])
  })

  it('refuses another version', () => {
    expect(parseHidApprovals(JSON.stringify({ version: 2, origins: { [APP]: [{ vendorId: 1, productId: 2 }] } })).size).toBe(0)
  })
})
