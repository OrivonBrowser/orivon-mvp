// A certificate as the viewer shows it: public display fields and the PEM, nothing that could act on a
// connection. Pure: the certificate is read through a structural type, so no `electron` import.
import { createHash } from 'node:crypto'

export interface PrincipalLike {
  readonly commonName: string
  readonly organizations: readonly string[]
}

/** The parts of Electron's `Certificate` the viewer reads. */
export interface CertificateLike {
  readonly data: string
  readonly fingerprint: string
  readonly issuer: PrincipalLike
  readonly issuerCert?: CertificateLike | null | undefined
  readonly issuerName: string
  readonly serialNumber: string
  readonly subject: PrincipalLike
  readonly subjectName: string
  /** Seconds since the epoch. */
  readonly validExpiry: number
  readonly validStart: number
}

export interface Party {
  readonly commonName: string
  readonly organization: string
}

export interface CertificateView {
  readonly subject: Party
  readonly issuer: Party
  /** Milliseconds since the epoch. */
  readonly validFrom: number
  readonly validUntil: number
  /** Hex pairs joined by colons. */
  readonly serial: string
  /** SHA-256 of the DER, as uppercase hex pairs joined by colons. */
  readonly fingerprint: string
  readonly pem: string
}

/** A chain deeper than this is not a chain anyone built on purpose. */
export const MAX_CHAIN = 6

const pairs = (hex: string): string => (hex.toUpperCase().match(/../g) ?? []).join(':')

/** The SHA-256 of the certificate's DER, read from its PEM; empty when the text is not a certificate. */
export function sha256Of (pem: string): string {
  const body = pem.replace(/-----(BEGIN|END) CERTIFICATE-----/g, '').replace(/\s+/g, '')
  if (body === '') return ''
  return pairs(createHash('sha256').update(Buffer.from(body, 'base64')).digest('hex'))
}

function party (principal: PrincipalLike, name: string): Party {
  return { commonName: principal.commonName !== '' ? principal.commonName : name, organization: principal.organizations[0] ?? '' }
}

export function viewOf (certificate: CertificateLike): CertificateView {
  return {
    subject: party(certificate.subject, certificate.subjectName),
    issuer: party(certificate.issuer, certificate.issuerName),
    validFrom: certificate.validStart * 1000,
    validUntil: certificate.validExpiry * 1000,
    serial: pairs(certificate.serialNumber.length % 2 === 1 ? `0${certificate.serialNumber}` : certificate.serialNumber),
    fingerprint: sha256Of(certificate.data),
    pem: certificate.data
  }
}

/** The certificate and the ones that vouch for it, leaf first, stopping at a root, a repeat or the depth limit. */
export function chainOf (leaf: CertificateLike): CertificateView[] {
  const chain: CertificateView[] = []
  const seen = new Set<string>()
  for (let current: CertificateLike | null | undefined = leaf; current !== null && current !== undefined && chain.length < MAX_CHAIN; current = current.issuerCert) {
    const view = viewOf(current)
    if (seen.has(view.fingerprint)) break
    seen.add(view.fingerprint)
    chain.push(view)
  }
  return chain
}
