// Node's tls.connect options, translated into what orivon.net.connectSecure
// takes, and the post-handshake verdict a TLSSocket reports. The broker does
// the handshake and the verification it was asked for; this file decides
// what to ask for and, when the app brings its own checkServerIdentity,
// finishes verification the way Node's onConnectSecure does.

import { Buffer } from 'buffer'
import type { SecureConnectOptions } from '../contracts/capability-api.js'
import type { PeerCertificate, SecureHandshake } from '../contracts/handles.js'
import { isIP } from './node-net-isip.js'
import { refuseShim, type OrivonShimError } from './errors.js'

export type BrokerTlsOptions = Omit<SecureConnectOptions, 'host' | 'port'>
type IdentityCheck = (hostname: string, cert: Record<string, unknown>) => unknown

/** What one TLS connection asks the broker for, and what the shim enforces after it answers. */
export interface TlsPlan {
  readonly broker: BrokerTlsOptions
  /** The app's own `rejectUnauthorized`: anything but `false` means verify. */
  readonly rejectUnauthorized: boolean
  readonly checkServerIdentity: IdentityCheck | undefined
}

/** A TLSSocket's view of the handshake, including the error that must destroy it. */
export interface TlsVerdict {
  readonly authorized: boolean
  readonly authorizationError: string | null
  readonly error: Error | undefined
}

const decoder = new TextDecoder()

/** A PEM value as Node accepts it (string or Buffer), as a string; undefined for anything else. */
function pemText (value: unknown): string | undefined {
  if (typeof value === 'string') return value
  if (value instanceof Uint8Array) return decoder.decode(value)
  return undefined
}

/** Node's `cert`/`key`/`pfx` may be a one-element array, or objects carrying their own passphrase; the broker takes one of each. */
function single (value: unknown): unknown {
  return Array.isArray(value) && value.length === 1 ? value[0] : value
}

/** ALPNProtocols as Node takes it: an array of strings or buffers, or one buffer in wire format (length-prefixed). */
function alpnList (value: unknown): string[] | undefined {
  if (Array.isArray(value)) return value.map(pemText).filter((entry): entry is string => entry !== undefined)
  if (!(value instanceof Uint8Array)) return undefined
  const names: string[] = []
  for (let at = 0; at < value.length;) {
    const length = value[at] ?? 0
    names.push(decoder.decode(value.subarray(at + 1, at + 1 + length)))
    at += 1 + length
  }
  return names
}

function unsupported (api: string, what: string, why: string): OrivonShimError {
  return refuseShim(api, 'unimplemented', `${api}: ${what} is not available -- ${why}`)
}

/** The credential fields, or the named refusal for a shape the broker has no single field for. */
function credentials (options: Record<string, unknown>, api: string): Partial<Record<'cert' | 'key' | 'passphrase', string>> & { pfx?: Uint8Array } | OrivonShimError {
  const out: Partial<Record<'cert' | 'key' | 'passphrase', string>> & { pfx?: Uint8Array } = {}
  if (typeof options.passphrase === 'string') out.passphrase = options.passphrase
  for (const field of ['cert', 'key'] as const) {
    const raw = single(options[field])
    if (raw === undefined || raw === null) continue
    const entry = typeof raw === 'object' && !(raw instanceof Uint8Array) && !Array.isArray(raw) ? raw as { pem?: unknown, passphrase?: unknown } : { pem: raw }
    const text = pemText(entry.pem)
    if (text === undefined) return unsupported(api, `this '${field}' shape`, 'pass one PEM string or Buffer.')
    out[field] = text
    if (typeof entry.passphrase === 'string') out.passphrase = entry.passphrase
  }
  const pfx = single(options.pfx)
  if (pfx !== undefined && pfx !== null) {
    const entry = pfx instanceof Uint8Array ? { buf: pfx } : pfx as { buf?: unknown, passphrase?: unknown }
    if (!(entry.buf instanceof Uint8Array)) return unsupported(api, "this 'pfx' shape", 'pass one PKCS#12 Buffer.')
    out.pfx = new Uint8Array(entry.buf)
    if (typeof entry.passphrase === 'string') out.passphrase = entry.passphrase
  }
  return out
}

/**
 * Builds the plan for `options`, or the named refusal. Refused: upgrading an
 * existing socket (STARTTLS), a prebuilt `secureContext`, and a credential
 * array holding more than one entry -- nothing the broker could apply.
 */
export function planTls (options: Record<string, unknown>, api: string): TlsPlan | OrivonShimError {
  if (options.socket !== undefined && options.socket !== null) {
    return unsupported(api, 'upgrading an existing socket (the `socket` option, STARTTLS)',
      'orivon.net.connectSecure opens a connection that is TLS from its first byte, and has no operation that upgrades a plain one in place.')
  }
  if (options.secureContext !== undefined && options.secureContext !== null) {
    return unsupported(api, "the 'secureContext' option", "a native context cannot cross to the broker; pass its ca/cert/key options instead.")
  }
  const check = options.checkServerIdentity
  if (check !== undefined && typeof check !== 'function') {
    return unsupported(api, 'a checkServerIdentity that is not a function', 'pass a function, as Node requires.')
  }
  const creds = credentials(options, api)
  if (creds instanceof Error) return creds

  const broker: Partial<Record<keyof BrokerTlsOptions, unknown>> = { ...creds }
  const rejectUnauthorized = options.rejectUnauthorized !== false
  // A custom identity check replaces the default one, as in Node, so the
  // broker must not refuse on the default check first: the shim enforces the
  // chain and runs the app's check itself (verdictFor below).
  if (!rejectUnauthorized || check !== undefined) broker.rejectUnauthorized = false
  if (options.ca !== undefined && options.ca !== null) {
    const ca = Array.isArray(options.ca) ? options.ca.map(pemText) : pemText(options.ca)
    if (Array.isArray(ca) ? ca.includes(undefined) : ca === undefined) return unsupported(api, "this 'ca' shape", 'pass PEM strings or Buffers.')
    broker.ca = ca
  }
  // An address is never sent as SNI (RFC 6066); Node warns and will drop it.
  if (typeof options.servername === 'string' && isIP(options.servername) === 0) broker.servername = options.servername
  const alpn = alpnList(options.ALPNProtocols)
  if (alpn !== undefined && alpn.length > 0) broker.alpnProtocols = alpn
  return { broker: broker as BrokerTlsOptions, rejectUnauthorized, checkServerIdentity: check as IdentityCheck | undefined }
}

/** The certificate in Node's getPeerCertificate() shape: its bytes as Buffers. `{}` when the peer presented none, as in Node. */
export function nodePeerCertificate (cert: PeerCertificate | null | undefined): Record<string, unknown> {
  if (cert === null || cert === undefined) return {}
  const shaped: Record<string, unknown> = { ...cert, subject: { ...cert.subject }, issuer: { ...cert.issuer }, raw: Buffer.from(cert.raw) }
  if (cert.pubkey !== undefined) shaped.pubkey = Buffer.from(cert.pubkey)
  return shaped
}

/** Node's verification error, rebuilt from the code the broker reported. */
function chainError (code: string): Error & { code: string } {
  return Object.assign(new Error(`certificate verification failed: ${code}`), { code })
}

/**
 * What the TLSSocket reports once the broker's handshake completed, and the
 * error that must destroy it before a byte is written, if any.
 *
 * With no custom check, the broker already applied the app's own
 * `rejectUnauthorized`, so its report stands. With one, the broker was told
 * not to refuse, and this runs Node's order: a chain error decides alone;
 * otherwise the app's check replaces the default hostname check. The broker
 * reports a hostname failure only as ERR_TLS_CERT_ALTNAME_INVALID -- Node's
 * default check has no other code -- so that code means the chain was fine.
 */
export function verdictFor (handshake: Partial<SecureHandshake>, plan: TlsPlan, identityHost: string): TlsVerdict {
  // A broker that reports no facts verified by default and refused on failure.
  const authorized = handshake.authorized ?? true
  const reported = handshake.authorizationError ?? 'UNABLE_TO_VERIFY_LEAF_SIGNATURE'
  const check = plan.checkServerIdentity
  if (check === undefined) return { authorized, authorizationError: authorized ? null : reported, error: undefined }

  let error: Error | undefined
  if (!authorized && reported !== 'ERR_TLS_CERT_ALTNAME_INVALID') {
    error = chainError(reported)
  } else {
    try {
      const result = check(identityHost, nodePeerCertificate(handshake.peerCertificate))
      error = result instanceof Error ? result : undefined
    } catch (thrown) {
      error = thrown instanceof Error ? thrown : new Error(String(thrown))
    }
  }
  if (error === undefined) return { authorized: true, authorizationError: null, error: undefined }
  const code = (error as { code?: unknown }).code
  return { authorized: false, authorizationError: typeof code === 'string' ? code : error.message, error: plan.rejectUnauthorized ? error : undefined }
}
