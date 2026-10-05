// What a start of the browser asks for once another one of the same profile is running: show the window, a new
// window, or a new private window. A launcher action (a dock or taskbar menu entry, a desktop-entry action) is a
// command-line flag; the running browser reads the request the second start sent it. Pure.
import { NEW_PRIVATE_WINDOW_FLAG, NEW_WINDOW_FLAG, urlsFromArgv } from './launch-context.js'

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
function operandsOf (argv: readonly string[], packaged: boolean): string[] {
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

/** The request a command line makes. No operand at all is a new window; an operand that is not a web address (a file, a `mailto:`) only brings the window forward. */
export function requestFromArgv (argv: readonly string[], packaged: boolean): LaunchRequest {
  const operands = operandsOf(argv, packaged)
  const urls = urlsFromArgv(operands)
  const switches = argv.slice(0, argv.includes('--') ? argv.indexOf('--') : undefined)
  if (switches.includes(NEW_PRIVATE_WINDOW_FLAG)) return { kind: 'private', urls }
  if (switches.includes(NEW_WINDOW_FLAG) || operands.length === 0) return { kind: 'window', urls }
  return { kind: 'open', urls }
}

export function launchData (request: LaunchRequest): LaunchData {
  return { orivonLaunch: 1, kind: request.kind, urls: request.urls }
}

function isAddressList (value: unknown): value is string[] {
  if (!Array.isArray(value) || value.length > MAX_ADDRESSES) return false
  return value.every((entry) => typeof entry === 'string' && urlsFromArgv([entry]).length === 1)
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
