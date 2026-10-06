// What a start of the browser asks for once another one of the same profile is running: show the window, a new
// window, or a new private window. A launcher action (a dock or taskbar menu entry, a desktop-entry action) is a
// command-line flag; the running browser reads the request the second start sent it. Pure.
import { sanitizeLocalFileUrl } from '../browsing/local-file-input.js'
import { NEW_PRIVATE_WINDOW_FLAG, NEW_WINDOW_FLAG, switchesOf, urlsFromArgv } from './launch-context.js'
import { addressesFromOperands } from './local-operand.js'
import type { PathKind } from './local-operand.js'

/** `open` only focuses the window in use, with the addresses in it; `window` and `private` open a new one. */
export type LaunchKind = 'open' | 'window' | 'private'

export interface LaunchRequest {
  readonly kind: LaunchKind
  readonly urls: readonly string[]
}

/** What a second start hands to the running one as the single-instance lock's additional data. */
export interface LaunchData {
  readonly orivonLaunch: 1
  readonly kind: LaunchKind
  readonly urls: readonly string[]
}

const KINDS: readonly LaunchKind[] = ['open', 'window', 'private']
const MAX_ADDRESSES = 8

/** The arguments that are not switches, after the program (and after the app path of a source run). Everything after `--` counts. */
export function operandsOf (argv: readonly string[], packaged: boolean): string[] {
  const operands: string[] = []
  let literal = false
  let appPathSkipped = packaged
  for (const argument of argv.slice(1)) {
    if (!literal && argument === '--') { literal = true; continue }
    if (!literal && argument.startsWith('-')) continue
    if (!appPathSkipped) { appPathSkipped = true; continue }
    operands.push(argument)
  }
  return operands
}

/** Where a path operand is read from, and how the disk is asked: the directory the start was made in, and a stand-in for the disk in a test. */
export interface OperandDisk {
  readonly cwd: string
  readonly kindOf?: (path: string) => PathKind
  readonly platform?: NodeJS.Platform
}

/** The http(s) addresses and local files a command line names, in its order, at most eight. */
export function launchAddresses (argv: readonly string[], packaged: boolean, disk: OperandDisk = { cwd: process.cwd() }): string[] {
  return addressesFromOperands(operandsOf(argv, packaged), disk.cwd, disk.kindOf, disk.platform)
}

/** The request a command line makes. No operand at all is a new window; an operand that is neither a web address nor a local file (a `mailto:`, a path that is not there) only brings the window forward. */
export function requestFromArgv (argv: readonly string[], packaged: boolean, disk: OperandDisk = { cwd: process.cwd() }): LaunchRequest {
  const operands = operandsOf(argv, packaged)
  const urls = launchAddresses(argv, packaged, disk)
  const switches = switchesOf(argv)
  if (switches.includes(NEW_PRIVATE_WINDOW_FLAG)) return { kind: 'private', urls }
  if (switches.includes(NEW_WINDOW_FLAG) || operands.length === 0) return { kind: 'window', urls }
  return { kind: 'open', urls }
}

/** A request that arrived while the browser was still starting: a new window with no address is the first window, so it only brings that one forward. */
export function atStartup (request: LaunchRequest): LaunchRequest {
  return request.kind === 'window' && request.urls.length === 0 ? { kind: 'open', urls: [] } : request
}

export function launchData (request: LaunchRequest): LaunchData {
  return { orivonLaunch: 1, kind: request.kind, urls: request.urls }
}

function isAddress (entry: unknown): entry is string {
  return typeof entry === 'string' && (urlsFromArgv([entry]).length === 1 || sanitizeLocalFileUrl(entry) !== null)
}

/** A list of addresses from another process: web addresses and local files, nothing else. A malformed one makes the whole list suspect. */
function isAddressList (value: unknown): value is string[] {
  return Array.isArray(value) && value.length <= MAX_ADDRESSES && value.every(isAddress)
}

/** The request the running browser was sent, checked as input from another process: anything malformed is read as a plain `open` of the addresses on the command line. */
export function readLaunchRequest (data: unknown, argv: readonly string[]): LaunchRequest {
  const record = typeof data === 'object' && data !== null ? data as Record<string, unknown> : undefined
  const kind = record?.['kind']
  const urls = record?.['urls']
  if (record?.['orivonLaunch'] !== 1 || !KINDS.includes(kind as LaunchKind) || !isAddressList(urls)) {
    return { kind: 'open', urls: urlsFromArgv(argv) }
  }
  return { kind: kind as LaunchKind, urls: urls.map((url) => new URL(url).toString()) }
}
