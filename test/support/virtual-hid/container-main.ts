// Runs as root inside the container (see virtual-hid/README.md): creates the uhid device, opens its
// hidraw node to every user on the host, prints one ready line, and answers reports until stopped.
import { chmodSync, closeSync, existsSync, openSync, readdirSync, read, realpathSync, writeSync } from 'node:fs'
import { basename } from 'node:path'
import { loadResponder, serialQueue } from './responder.ts'
import type { DeviceControl } from './responder.ts'
import {
  READY_PREFIX, REPLUGGED_PREFIX, UHID_CLOSE, UHID_EVENT_SIZE, UHID_OPEN, UHID_START, bytesToHex, instanceMatches,
  packCreate2, packDestroy, packInput2, parseEvent, stripReportId
} from './uhid.ts'
import type { VirtualHidDeviceOptions } from './uhid.ts'

const HOST_DEV = '/hostdev'
/** How long a replug waits for the host to read the last answer, and how long the device stays unplugged. */
const REPLUG_GRACE_MS = 100
const REPLUG_DOWN_MS = 500

const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms))

function argument (name: string): string | undefined {
  const at = process.argv.indexOf(name)
  return at === -1 ? undefined : process.argv[at + 1]
}

function log (message: string): void {
  process.stdout.write(`[virtual-hid] ${message}\n`)
}

/** Instance name to hidraw node, for every device with these ids that exists now. */
function matchingInstances (options: VirtualHidDeviceOptions): Map<string, string> {
  const found = new Map<string, string>()
  for (const entry of readdirSync('/sys/class/hidraw')) {
    try {
      const instance = basename(realpathSync(`/sys/class/hidraw/${entry}/device`))
      if (instanceMatches(instance, options.vendorId, options.productId)) found.set(instance, entry)
    } catch { /* the node went away while it was listed */ }
  }
  return found
}

/**
 * Creates the device and opens its node to every user. The node is the one whose instance did not exist before
 * the create, so a device with the same ids, or this device's own earlier plug, is never taken for it.
 */
async function plug (fd: number, options: VirtualHidDeviceOptions): Promise<string> {
  const before = new Set(matchingInstances(options).keys())
  writeSync(fd, packCreate2(options))
  for (let attempt = 0; attempt < 100; attempt++) {
    for (const [instance, node] of matchingInstances(options)) {
      if (before.has(instance)) continue
      // The sysfs entry can show before the kernel's devtmpfs node does (seen on a hosted CI runner).
      await waitForNode(`${HOST_DEV}/${node}`)
      chmodSync(`${HOST_DEV}/${node}`, 0o666)
      return node
    }
    await sleep(100)
  }
  throw new Error('the hidraw node did not appear within 10 s')
}

async function waitForNode (path: string): Promise<void> {
  for (let attempt = 0; attempt < 100 && !existsSync(path); attempt++) await sleep(100)
}

async function main (): Promise<void> {
  const options = JSON.parse(argument('--options') ?? '{}') as VirtualHidDeviceOptions
  const responder = await loadResponder(argument('--responder') ?? 'echo')
  const lifetimeMs = Number(argument('--lifetime-s') ?? '600') * 1000
  const fd = openSync('/dev/uhid', 'r+')
  let destroyed = false
  const destroy = (): void => {
    if (destroyed) return
    destroyed = true
    try { writeSync(fd, packDestroy()) } catch { /* the kernel destroys the device when the descriptor closes */ }
    try { closeSync(fd) } catch { /* already closed */ }
    log('destroyed')
    process.exit(0)
  }
  process.on('SIGTERM', destroy)
  process.on('SIGINT', destroy)
  setTimeout(destroy, lifetimeMs).unref()

  const node = await plug(fd, options)
  let replugging: Promise<void> = Promise.resolve()
  const device: DeviceControl = {
    replug: () => {
      replugging = replugging.then(async () => {
        await sleep(REPLUG_GRACE_MS)
        if (destroyed) return
        writeSync(fd, packDestroy())
        log('unplugged')
        await sleep(REPLUG_DOWN_MS)
        if (destroyed) return
        const again = await plug(fd, options)
        log(`plugged in again as ${again}`)
        process.stdout.write(`${REPLUGGED_PREFIX}${JSON.stringify({ node: again })}\n`)
      }).catch((error: unknown) => { log(`replug failed: ${String(error)}`) })
    }
  }

  const answer = serialQueue(
    responder,
    (report) => {
      log(`input ${report.length} bytes ${bytesToHex(report.slice(0, 8))}`)
      writeSync(fd, packInput2(report))
    },
    (error) => { log(`responder failed: ${String(error)}`) },
    device
  )
  const readNext = (): void => {
    if (destroyed) return
    const buffer = Buffer.alloc(UHID_EVENT_SIZE)
    read(fd, buffer, 0, UHID_EVENT_SIZE, null, (error, bytes) => {
      if (destroyed) return
      if (error !== null || bytes === 0) { log(`uhid read ended: ${error?.message ?? 'eof'}`); destroy(); return }
      const event = parseEvent(buffer)
      if (event.type === 'output') {
        const report = stripReportId(event.data, options.reportIds === true)
        log(`output ${event.data.length} bytes (report ${report.length})`)
        void answer(report)
      } else if (event.code === UHID_OPEN) log('open')
      else if (event.code === UHID_CLOSE) log('close')
      else if (event.code === UHID_START) log('start')
      else log(`event ${event.code}`)
      readNext()
    })
  }
  readNext()
  process.stdout.write(`${READY_PREFIX}${JSON.stringify({ node })}\n`)
}

main().catch((error: unknown) => {
  process.stdout.write(`[virtual-hid] failed: ${String(error)}\n`)
  process.exit(1)
})
