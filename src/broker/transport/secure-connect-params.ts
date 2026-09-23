// `net.connectSecure`'s payload: `host` and `port` exactly as net.connect's,
// plus Node's TLS options (contracts' SecureConnectOptions), each shape- and
// size-checked here, at the trust boundary, before the policy or the TLS
// stack sees it. ./ipc-validation.ts's header says why nothing arriving on
// CONTROL_CHANNEL is trusted.
//
// A refusal names the option and the rule it broke, NEVER the value: a key
// or passphrase must not reach a log line or the page through an error.

import type { SecureConnectOptions } from '../../contracts/index.js'
import { classifyAddress } from '../policy/address.js'
import { MAX_HOST_LENGTH } from '../policy/canonical-host.js'

/**
 * Far above any real certificate chain, key, CA bundle or PKCS#12 file, and
 * there so that one call cannot make the main process parse megabytes of
 * app-supplied input (security-model.md T11b): the broker loads all of it
 * synchronously, on its own thread, when the handshake starts.
 */
export const SECURE_CONNECT_LIMITS = {
  /** `cert` and `key`, each: a chain of a dozen certificates fits. */
  pemChars: 64 * 1024,
  caEntries: 64,
  /** Every `ca` string together. */
  caTotalChars: 512 * 1024,
  pfxBytes: 64 * 1024,
  passphraseChars: 1024,
  alpnEntries: 16,
  /** RFC 7301: a protocol name is at most 255 bytes. */
  alpnEntryChars: 255
} as const

export type SecureConnectParse =
  | { readonly ok: true, readonly params: SecureConnectOptions }
  | { readonly ok: false, readonly problem: string }

type Problem = string | undefined
type Mutable<T> = { -readonly [K in keyof T]: T[K] }

const KNOWN_KEYS: ReadonlySet<string> = new Set([
  'host', 'port', 'rejectUnauthorized', 'ca', 'cert', 'key', 'pfx', 'passphrase', 'servername', 'alpnProtocols'
])

/** A hostname's own characters, nothing else: SNI carries a DNS name, and a space or control byte there is never legitimate. */
const HOSTNAME_CHARS = /^[A-Za-z0-9._-]+$/
/** Printable ASCII: every registered ALPN protocol id is spelled in it. */
const ALPN_CHARS = /^[\x21-\x7e]+$/

function pemProblem (name: string, value: unknown): Problem {
  if (typeof value !== 'string') return `${name} must be a PEM string`
  if (value.length > SECURE_CONNECT_LIMITS.pemChars) return `${name} exceeds ${String(SECURE_CONNECT_LIMITS.pemChars)} characters`
  return undefined
}

function caProblem (value: unknown): Problem {
  const entries = typeof value === 'string' ? [value] : value
  if (!Array.isArray(entries) || !entries.every((entry) => typeof entry === 'string')) {
    return 'ca must be a PEM string or an array of them'
  }
  if (entries.length > SECURE_CONNECT_LIMITS.caEntries) return `ca exceeds ${String(SECURE_CONNECT_LIMITS.caEntries)} entries`
  const total = (entries as string[]).reduce((sum, entry) => sum + entry.length, 0)
  if (total > SECURE_CONNECT_LIMITS.caTotalChars) return `ca exceeds ${String(SECURE_CONNECT_LIMITS.caTotalChars)} characters in total`
  return undefined
}

function servernameProblem (value: unknown): Problem {
  if (typeof value !== 'string') return 'servername must be a string'
  if (value === '') return undefined
  if (value.length > MAX_HOST_LENGTH || !HOSTNAME_CHARS.test(value)) return 'servername must be a DNS hostname'
  if (classifyAddress(value) !== 'unparseable') return 'servername must be a name, never an address literal: SNI cannot carry one'
  return undefined
}

function alpnProblem (value: unknown): Problem {
  const { alpnEntries, alpnEntryChars } = SECURE_CONNECT_LIMITS
  if (!Array.isArray(value)) return 'alpnProtocols must be an array of strings'
  if (value.length > alpnEntries) return `alpnProtocols exceeds ${String(alpnEntries)} entries`
  const valid = value.every((entry) => typeof entry === 'string' && entry.length <= alpnEntryChars && ALPN_CHARS.test(entry))
  return valid ? undefined : `alpnProtocols entries must be 1 to ${String(alpnEntryChars)} printable ASCII characters`
}

/** The problem with one option's value, or undefined when it is acceptable. Never called with `undefined`. */
function optionProblem (key: string, value: unknown): Problem {
  switch (key) {
    case 'host': return typeof value === 'string' ? undefined : 'host must be a string'
    case 'port': return typeof value === 'number' ? undefined : 'port must be a number'
    case 'rejectUnauthorized': return typeof value === 'boolean' ? undefined : 'rejectUnauthorized must be a boolean'
    case 'ca': return caProblem(value)
    case 'cert': case 'key': return pemProblem(key, value)
    case 'pfx':
      if (!(value instanceof Uint8Array)) return 'pfx must be a Uint8Array'
      return value.byteLength > SECURE_CONNECT_LIMITS.pfxBytes ? `pfx exceeds ${String(SECURE_CONNECT_LIMITS.pfxBytes)} bytes` : undefined
    case 'passphrase':
      if (typeof value !== 'string') return 'passphrase must be a string'
      return value.length > SECURE_CONNECT_LIMITS.passphraseChars ? `passphrase exceeds ${String(SECURE_CONNECT_LIMITS.passphraseChars)} characters` : undefined
    case 'servername': return servernameProblem(value)
    case 'alpnProtocols': return alpnProblem(value)
    default: return `unknown option '${key}'`
  }
}

/**
 * Validates `payload` and rebuilds it from the known keys only, omitting any
 * set to `undefined` (exactOptionalPropertyTypes: an explicit `undefined` is
 * not an absent key, and the broker treats "present" as "the app chose").
 */
export function parseSecureConnectParams (payload: unknown): SecureConnectParse {
  if (typeof payload !== 'object' || payload === null || Array.isArray(payload)) {
    return { ok: false, problem: 'expected an object of connection options' }
  }
  const source = payload as Record<string, unknown>
  for (const required of ['host', 'port']) {
    if (source[required] === undefined) return { ok: false, problem: `${required} is required` }
  }
  const params: Partial<Mutable<SecureConnectOptions>> = {}
  for (const key of Object.keys(source)) {
    const value = source[key]
    if (value === undefined && KNOWN_KEYS.has(key)) continue
    const problem = optionProblem(key, value)
    if (problem !== undefined) return { ok: false, problem }
    ;(params as Record<string, unknown>)[key] = value
  }
  return { ok: true, params: params as SecureConnectOptions }
}
