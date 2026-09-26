// Node's argument normalisation and validation for net.connect,
// socket.connect, server.listen and tls.connect, in one place so the four
// accept the same overloads and throw the same ERR_* errors Node does.

import { codedError } from '../node-errors.js'

export interface ConnectTarget {
  readonly port?: unknown
  readonly host?: unknown
  readonly path?: unknown
  readonly [key: string]: unknown
}

/** Node's validatePort: a number or numeric string in 0..65535, whitespace-only strings refused. */
export function validatePort (port: unknown, name = 'Port', allowZero = true): number {
  const numeric = typeof port === 'number' || typeof port === 'string' ? Number(port) : Number.NaN
  const blank = typeof port === 'string' && port.trim() === ''
  if ((typeof port !== 'number' && typeof port !== 'string') || blank ||
      numeric !== (numeric >>> 0) || numeric > 0xffff || (numeric === 0 && !allowZero)) {
    throw codedError(RangeError, 'ERR_SOCKET_BAD_PORT',
      `${name} should be >= 0 and < 65536. Received ${describeReceived(port)}.`)
  }
  return numeric
}

function describeReceived (value: unknown): string {
  if (value === null || value === undefined) return String(value)
  if (typeof value === 'string') return `type string ('${value}')`
  if (typeof value === 'number' || typeof value === 'boolean') return `type ${typeof value} (${String(value)})`
  return `an instance of ${(value as object).constructor?.name ?? 'Object'}`
}

/** A string that is not a port number names a local IPC endpoint in Node (`connect('/tmp/app.sock')`). */
function isPipeName (value: unknown): value is string {
  return typeof value === 'string' && Number.isNaN(Number(value))
}

/**
 * Node's normalizeArgs for connect: `(options[, cb])`, `(path[, cb])`,
 * `(port[, host][, cb])`. The listener is found by scanning from the end, so
 * one arm covers `(port, cb)` and `(port, host, cb)` alike.
 */
export function normalizeConnectArgs (args: readonly unknown[]): { options: ConnectTarget, callback: (() => void) | undefined } {
  const last = args[args.length - 1]
  const callback = typeof last === 'function' ? last as () => void : undefined
  const [first, second] = args
  if (typeof first === 'object' && first !== null) return { options: first as ConnectTarget, callback }
  if (isPipeName(first)) return { options: { path: first }, callback }
  const options: Record<string, unknown> = { port: first }
  if (typeof second === 'string') options.host = second
  return { options, callback }
}

/** The port a connect call dials, validated the way Node validates it before any I/O happens. */
export function connectPort (options: ConnectTarget): number {
  if (options.port === undefined) {
    throw codedError(TypeError, 'ERR_MISSING_ARGS', 'The "options" or "port" or "path" argument must be specified')
  }
  if (typeof options.port !== 'number' && typeof options.port !== 'string') {
    throw codedError(TypeError, 'ERR_INVALID_ARG_TYPE',
      `The "options.port" property must be one of type number or string. Received ${describeReceived(options.port)}`)
  }
  return validatePort(options.port)
}
