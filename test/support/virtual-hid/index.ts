// Puts a virtual USB HID device on this Linux machine for the length of a test. The root-only part (creating
// the device through /dev/uhid and opening its hidraw node) runs in a short-lived Docker container, so
// nothing stays installed. See README.md in this folder.
import { execFile, spawn } from 'node:child_process'
import { randomBytes } from 'node:crypto'
import { existsSync } from 'node:fs'
import { dirname, basename, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { promisify } from 'node:util'
import { READY_PREFIX, REPLUGGED_PREFIX, bytesToHex } from './uhid.ts'
import type { VirtualHidDeviceOptions } from './uhid.ts'

const run = promisify(execFile)
const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '../../..')
const IN_CONTAINER_MAIN = '/w/test/support/virtual-hid/container-main.ts'
export const DEFAULT_IMAGE = process.env.ORIVON_VIRTUAL_HID_IMAGE ?? 'node:24-slim'

export interface StartVirtualHidOptions extends Omit<VirtualHidDeviceOptions, 'descriptorHex'> {
  /** The report descriptor; the default is a vendor-page device with 64-byte input and output reports. */
  readonly descriptor?: Uint8Array
  /** Path of a .ts module whose default export is `(report, send) => void | Promise<void>`; default is echo. */
  readonly responder?: string
  /** Passed to the container as `-e K=V`; the container shares the host network (`--network host`). */
  readonly env?: Record<string, string>
  readonly image?: string
  /** How long to wait for the device to appear, after the image is present. Default 20 s. */
  readonly readyTimeoutMs?: number
  /** The container destroys the device by itself after this long, whatever the test did. Default 600 s. */
  readonly lifetimeS?: number
}

export interface VirtualHidDevice {
  /** `hidrawN` now; the host path is `/dev/${node}` and is mode 0666. A responder's `replug()` can change it. */
  readonly node: string
  /** The container's output so far: open, close and report sizes. */
  logs: () => string
  /** Destroys the device and removes the container; safe to call twice. */
  stop: () => Promise<void>
}

/** True when a device can be created here, else the reason it cannot. */
export async function virtualHidAvailable (): Promise<true | string> {
  if (process.platform !== 'linux') return 'a virtual HID device needs Linux (uhid)'
  if (!existsSync('/dev/uhid')) return '/dev/uhid is missing (try `sudo modprobe uhid`)'
  try {
    await run('docker', ['version', '--format', '{{.Server.Version}}'], { timeout: 15_000 })
  } catch (error) {
    const text = String((error as { stderr?: string }).stderr ?? error)
    return /ENOENT/.test(String(error)) ? 'docker is not installed' : `docker is not usable: ${text.trim().split('\n')[0]}`
  }
  return true
}

async function ensureImage (image: string): Promise<void> {
  try {
    await run('docker', ['image', 'inspect', image], { timeout: 15_000 })
  } catch {
    await run('docker', ['pull', '-q', image], { timeout: 300_000 })
  }
}

function nodeGone (node: string): boolean {
  return !existsSync(`/sys/class/hidraw/${node}`)
}

export async function startVirtualHidDevice (options: StartVirtualHidOptions): Promise<VirtualHidDevice> {
  const image = options.image ?? DEFAULT_IMAGE
  const name = `orivon-vhid-${process.pid}-${randomBytes(4).toString('hex')}`
  const config: VirtualHidDeviceOptions = {
    vendorId: options.vendorId,
    productId: options.productId,
    name: options.name,
    serial: options.serial,
    ...(options.reportIds === undefined ? {} : { reportIds: options.reportIds }),
    ...(options.descriptor === undefined ? {} : { descriptorHex: bytesToHex(options.descriptor) })
  }
  const args = [
    'run', '--rm', '-d', '--name', name, '--label', 'orivon-virtual-hid=1', '--network', 'host',
    '--device', '/dev/uhid', '-v', '/dev:/hostdev', '-v', `${REPO_ROOT}:/w:ro`
  ]
  const innerArgs = [IN_CONTAINER_MAIN, '--options', JSON.stringify(config), '--lifetime-s', String(options.lifetimeS ?? 600)]
  if (options.responder !== undefined) {
    const responder = resolve(options.responder)
    args.push('-v', `${dirname(responder)}:/responder:ro`)
    innerArgs.push('--responder', `/responder/${basename(responder)}`)
  }
  for (const [key, value] of Object.entries(options.env ?? {})) args.push('-e', `${key}=${value}`)

  await ensureImage(image)
  let output = ''
  let stopped = false
  const remove = async (): Promise<void> => {
    if (stopped) return
    stopped = true
    await run('docker', ['stop', '-t', '3', name], { timeout: 30_000 }).catch(() => {})
    await run('docker', ['rm', '-f', name], { timeout: 30_000 }).catch(() => {})
  }
  await run('docker', [...args, image, 'node', '--no-warnings', ...innerArgs], { timeout: 60_000 })
  const logger = spawn('docker', ['logs', '-f', name], { stdio: ['ignore', 'pipe', 'pipe'] })
  const finish = async (): Promise<void> => {
    await remove()
    logger.kill()
  }
  let ready: (node: string) => void = () => {}
  let failed: (error: Error) => void = () => {}
  const found = new Promise<string>((resolveNode, reject) => { ready = resolveNode; failed = reject })
  let latest = ''
  const nodeOf = (line: string, prefix: string): string => (JSON.parse(line.slice(prefix.length)) as { node: string }).node
  const onData = (chunk: Buffer): void => {
    output += chunk.toString()
    // The last piece is a line still being written.
    for (const line of output.split('\n').slice(0, -1)) {
      if (line.startsWith(READY_PREFIX)) { latest = nodeOf(line, READY_PREFIX); ready(latest) }
      else if (line.startsWith(REPLUGGED_PREFIX)) latest = nodeOf(line, REPLUGGED_PREFIX)
      else if (line.startsWith('[virtual-hid] failed:')) failed(new Error(line))
    }
  }
  logger.stdout.on('data', onData)
  logger.stderr.on('data', onData)
  logger.on('exit', () => { failed(new Error(`the container ended before the device was ready:\n${output}`)) })

  const timeout = options.readyTimeoutMs ?? 20_000
  let timer: NodeJS.Timeout | undefined
  try {
    await Promise.race([
      found,
      new Promise<never>((_resolve, reject) => { timer = setTimeout(() => { reject(new Error(`no virtual HID device after ${timeout} ms:\n${output}`)) }, timeout) })
    ])
    return {
      get node () { return latest },
      logs: () => output,
      stop: async () => {
        await finish()
        for (let i = 0; i < 50 && !nodeGone(latest); i++) await new Promise((r) => setTimeout(r, 100))
      }
    }
  } catch (error) {
    await finish()
    throw error
  } finally {
    clearTimeout(timer)
  }
}
