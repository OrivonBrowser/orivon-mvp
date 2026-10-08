// Runs as root inside the container (see virtual-hid/README.md): creates the uhid device, opens its
// hidraw node to every user on the host, prints one ready line, and answers reports until stopped.
import { chmodSync, closeSync, existsSync, openSync, readFileSync, readdirSync, read, writeSync } from 'node:fs'
import { loadResponder, serialQueue } from './responder.ts'
import {
  READY_PREFIX, UHID_CLOSE, UHID_EVENT_SIZE, UHID_OPEN, UHID_START, bytesToHex, hidrawNameOf, packCreate2,
  packDestroy, packInput2, parseEvent, stripReportId, ueventMatches
} from './uhid.ts'
import type { VirtualHidDeviceOptions } from './uhid.ts'

const HOST_DEV = '/hostdev'

function argument (name: string): string | undefined {
  const at = process.argv.indexOf(name)
  return at === -1 ? undefined : process.argv[at + 1]
}

function log (message: string): void {
  process.stdout.write(`[virtual-hid] ${message}\n`)
}

async function findNode (options: VirtualHidDeviceOptions): Promise<string> {
  for (let attempt = 0; attempt < 100; attempt++) {
    for (const entry of readdirSync('/sys/class/hidraw')) {
      const path = `/sys/class/hidraw/${entry}/device/uevent`
      const name = hidrawNameOf(path)
      if (name !== undefined && ueventMatches(readFileSync(path, 'utf8'), options.vendorId, options.productId)) return name
    }
    await new Promise((resolve) => setTimeout(resolve, 100))
  }
  throw new Error('the hidraw node did not appear within 10 s')
}

async function waitForNode (path: string): Promise<void> {
  for (let attempt = 0; attempt < 100 && !existsSync(path); attempt++) await new Promise((resolve) => setTimeout(resolve, 100))
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

  writeSync(fd, packCreate2(options))
  const node = await findNode(options)
  // The sysfs entry can show before the kernel's devtmpfs node does (seen on a hosted CI runner).
  await waitForNode(`${HOST_DEV}/${node}`)
  chmodSync(`${HOST_DEV}/${node}`, 0o666)

  const answer = serialQueue(
    responder,
    (report) => {
      log(`input ${report.length} bytes ${bytesToHex(report.slice(0, 8))}`)
      writeSync(fd, packInput2(report))
    },
    (error) => { log(`responder failed: ${String(error)}`) }
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
