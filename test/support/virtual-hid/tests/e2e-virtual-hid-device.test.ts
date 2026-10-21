// The tool proving itself against a real kernel: a device made through Docker and /dev/uhid shows up as a
// world-writable hidraw node, echoes a report, and is gone after stop(). ORIVON_REQUIRE_VIRTUAL_HID=1 turns the
// skip into a failure, for a machine that is meant to have it.
import { existsSync, mkdtempSync, realpathSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { open } from 'node:fs/promises'
import { expect, it } from 'vitest'
import { startVirtualHidDevice, virtualHidAvailable } from '../index.ts'

const availability = await virtualHidAvailable()
const required = process.env.ORIVON_REQUIRE_VIRTUAL_HID === '1'
if (availability !== true && required) throw new Error(`virtual HID is required but unavailable: ${availability}`)

const name = availability === true ? 'makes a hidraw node anyone can open, echoes a report and removes the node on stop' : `skipped: ${availability}`
const test = availability === true ? it : it.skip

test(name, async () => {
  const device = await startVirtualHidDevice({ vendorId: 0x1209, productId: 0x0001, name: 'Test Key', serial: 'SN-ECHO' })
  const path = `/dev/${device.node}`
  try {
    expect(statSync(path).mode & 0o777).toBe(0o666)
    const handle = await open(path, 'r+')
    try {
      const out = Buffer.alloc(65)
      for (let i = 1; i < 65; i++) out[i] = i
      expect((await handle.write(out)).bytesWritten).toBe(65)
      const back = Buffer.alloc(64)
      const read = await Promise.race([
        handle.read(back, 0, 64, null),
        new Promise<never>((_resolve, reject) => setTimeout(() => { reject(new Error('no echo within 10 s')) }, 10_000).unref())
      ])
      expect(read.bytesRead).toBe(64)
      expect([...back]).toEqual([...out.subarray(1)])
    } finally {
      await handle.close().catch(() => {})
    }
    await expect.poll(device.logs, { timeout: 3_000 }).toMatch(/output 65 bytes/)
  } finally {
    await device.stop()
  }
  expect(existsSync(`/sys/class/hidraw/${device.node}`)).toBe(false)
  await device.stop()
}, 60_000)

const withResponder = availability === true ? it : it.skip

/** Writes one unnumbered report whose first byte is `first` and returns the first byte of the answer. */
async function roundTrip (node: string, first: number): Promise<number> {
  const handle = await open(`/dev/${node}`, 'r+')
  try {
    const out = Buffer.alloc(65)
    out[1] = first
    await handle.write(out)
    const back = Buffer.alloc(64)
    await Promise.race([
      handle.read(back, 0, 64, null),
      new Promise<never>((_resolve, reject) => setTimeout(() => { reject(new Error('no answer within 10 s')) }, 10_000).unref())
    ])
    return back.readUInt8(0)
  } finally {
    await handle.close().catch(() => {})
  }
}

withResponder(availability === true ? 'gives each of two identical devices its own node, both open to every user' : `skipped: ${availability}`, async () => {
  const twin = { vendorId: 0x1209, productId: 0x0005, name: 'Test Key', serial: 'SN-TWIN' }
  const first = await startVirtualHidDevice(twin)
  try {
    const second = await startVirtualHidDevice(twin)
    try {
      expect(second.node).not.toBe(first.node)
      for (const node of [first.node, second.node]) expect(statSync(`/dev/${node}`).mode & 0o777).toBe(0o666)
    } finally {
      await second.stop()
    }
  } finally {
    await first.stop()
  }
}, 60_000)

withResponder(availability === true ? 'unplugs and plugs back in when the responder asks, after the host reads the answer' : `skipped: ${availability}`, async () => {
  const dir = mkdtempSync(join(tmpdir(), 'vhid-responder-'))
  writeFileSync(join(dir, 'replug.ts'), `
export default (report: Uint8Array, send: (r: Uint8Array) => void, device: { replug: () => void }): void => {
  send(report)
  if (report[0] === 7) device.replug()
}`)
  const device = await startVirtualHidDevice({
    vendorId: 0x1209, productId: 0x0004, name: 'Test Key', serial: 'SN-REPLUG', responder: join(dir, 'replug.ts')
  })
  try {
    const before = realpathSync(`/sys/class/hidraw/${device.node}/device`)
    expect(await roundTrip(device.node, 7)).toBe(7)
    await expect.poll(device.logs, { timeout: 10_000 }).toMatch(/ORIVON_VIRTUAL_HID_REPLUGGED /)
    expect(realpathSync(`/sys/class/hidraw/${device.node}/device`)).not.toBe(before)
    expect(existsSync(before)).toBe(false)
    expect(statSync(`/dev/${device.node}`).mode & 0o777).toBe(0o666)
    expect(await roundTrip(device.node, 3)).toBe(3)
  } finally {
    await device.stop()
    rmSync(dir, { recursive: true, force: true })
  }
}, 60_000)

withResponder(availability === true ? 'lets the host open and write to the new node the moment the replug ready line appears' : `skipped: ${availability}`, async () => {
  const dir = mkdtempSync(join(tmpdir(), 'vhid-responder-'))
  writeFileSync(join(dir, 'replug.ts'), `
export default (report: Uint8Array, send: (r: Uint8Array) => void, device: { replug: () => void }): void => {
  send(report)
  if (report[0] === 7) device.replug()
}`)
  const device = await startVirtualHidDevice({
    vendorId: 0x1209, productId: 0x0006, name: 'Test Key', serial: 'SN-FAST', responder: join(dir, 'replug.ts')
  })
  try {
    expect(await roundTrip(device.node, 7)).toBe(7)
    let node: string | undefined
    await expect.poll(() => {
      node = /ORIVON_VIRTUAL_HID_REPLUGGED .*"node":"(hidraw\d+)"/.exec(device.logs())?.[1]
      return node
    }, { timeout: 10_000 }).toBeDefined()
    // No wait and no stat: a page opens the device as soon as it hears `connect`.
    const handle = await open(`/dev/${node ?? ''}`, 'r+')
    try {
      const out = Buffer.alloc(65)
      out[1] = 3
      expect((await handle.write(out)).bytesWritten).toBe(65)
    } finally {
      await handle.close().catch(() => {})
    }
  } finally {
    await device.stop()
    rmSync(dir, { recursive: true, force: true })
  }
}, 60_000)

withResponder(availability === true ? 'runs a responder from outside the repository, with its environment, answering slow reports in order' : `skipped: ${availability}`, async () => {
  const dir = mkdtempSync(join(tmpdir(), 'vhid-responder-'))
  writeFileSync(join(dir, 'tag.ts'), `
const tag = Number(process.env.VHID_TAG)
export default async (report: Uint8Array, send: (r: Uint8Array) => void): Promise<void> => {
  await new Promise((resolve) => setTimeout(resolve, report[0] === 1 ? 200 : 0))
  send(Uint8Array.from([report[0], tag]))
}`)
  const device = await startVirtualHidDevice({
    vendorId: 0x1209, productId: 0x0002, name: 'Test Key', serial: 'SN-RESP', responder: join(dir, 'tag.ts'), env: { VHID_TAG: '42' }
  })
  try {
    const handle = await open(`/dev/${device.node}`, 'r+')
    try {
      for (const first of [1, 2]) {
        const out = Buffer.alloc(65)
        out[1] = first
        await handle.write(out)
      }
      const seen: number[][] = []
      for (let i = 0; i < 2; i++) {
        const back = Buffer.alloc(64)
        await Promise.race([
          handle.read(back, 0, 64, null),
          new Promise<never>((_resolve, reject) => setTimeout(() => { reject(new Error('no answer within 10 s')) }, 10_000).unref())
        ])
        seen.push([back.readUInt8(0), back.readUInt8(1)])
      }
      expect(seen).toEqual([[1, 42], [2, 42]])
    } finally {
      await handle.close().catch(() => {})
    }
  } finally {
    await device.stop()
    rmSync(dir, { recursive: true, force: true })
  }
}, 60_000)

withResponder(availability === true ? 'fails with the container output and leaves nothing behind when the responder cannot load' : `skipped: ${availability}`, async () => {
  await expect(startVirtualHidDevice({
    vendorId: 0x1209, productId: 0x0003, name: 'Test Key', serial: 'SN-BAD', responder: '/nonexistent/none.ts', readyTimeoutMs: 8_000
  })).rejects.toThrow(/virtual-hid|container ended/)
}, 60_000)
