// Node's `getPeerCertificate()` result, reduced to the plain, structured-
// cloneable `PeerCertificate` the contract promises: it crosses Electron IPC
// and contextBridge, where a Buffer, a null-prototype object or a circular
// `issuerCertificate` would not survive as the page expects.

import type { PeerCertificate as NodePeerCertificate } from 'node:tls'
import type { PeerCertificate } from '../../contracts/index.js'

type DistinguishedName = Readonly<Record<string, string | readonly string[]>>

/** A copy with a normal prototype, keeping only string and string-array values: Node builds these with a null prototype. */
function plainName (name: unknown): DistinguishedName {
  const out: Record<string, string | readonly string[]> = {}
  if (typeof name !== 'object' || name === null) return out
  for (const [field, value] of Object.entries(name)) {
    if (typeof value === 'string') out[field] = value
    else if (Array.isArray(value) && value.every((entry) => typeof entry === 'string')) out[field] = [...value as string[]]
  }
  return out
}

/** A copy that owns its bytes, so the page never holds a view onto a pooled Node buffer. */
function ownBytes (bytes: Uint8Array): Uint8Array {
  return new Uint8Array(bytes)
}

/** Null when the peer presented no certificate: Node's answer then is `{}`, with no `raw`. */
export function toPeerCertificate (cert: NodePeerCertificate | Record<string, never> | null | undefined): PeerCertificate | null {
  if (cert === null || cert === undefined || !('raw' in cert) || !(cert.raw instanceof Uint8Array)) return null
  const peer: { -readonly [K in keyof PeerCertificate]: PeerCertificate[K] } = {
    subject: plainName(cert.subject),
    issuer: plainName(cert.issuer),
    valid_from: String(cert.valid_from),
    valid_to: String(cert.valid_to),
    serialNumber: String(cert.serialNumber),
    fingerprint: String(cert.fingerprint),
    fingerprint256: String(cert.fingerprint256),
    raw: ownBytes(cert.raw)
  }
  if (typeof cert.subjectaltname === 'string') peer.subjectaltname = cert.subjectaltname
  if (cert.pubkey instanceof Uint8Array) peer.pubkey = ownBytes(cert.pubkey)
  return peer
}
