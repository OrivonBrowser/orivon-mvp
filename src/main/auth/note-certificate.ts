// The one place the verify proc tells the viewer what a connection presented. It runs inside the session's
// certificate verify proc, which answers every TLS connection and must never be slowed or broken by this.
import { CertificateCache } from './certificate-cache.js'
import { chainOf, sha256Of } from './certificate-view.js'
import type { CertificateLike } from './certificate-view.js'

/** Every host's certificate in this process; the viewer reads it for the page a tab is on. */
export const certificates = new CertificateCache()

type Candidate = CertificateLike | null | undefined

const readable = (certificate: Candidate): certificate is CertificateLike => typeof certificate?.data === 'string' && certificate.data !== ''

/** Records the first certificate that can be read: the validated one, which has its issuers, else the one presented. `trusted` says the connection was accepted. */
export function noteInto (cache: CertificateCache, host: string, trusted: boolean, candidates: readonly Candidate[]): void {
  try {
    const certificate = candidates.find(readable)
    if (certificate === undefined) return
    // The same certificate again, with nothing to upgrade, costs one hash.
    if (cache.leafOf(host) === sha256Of(certificate.data) && (!trusted || cache.trustedOf(host))) return
    cache.set(host, chainOf(certificate), trusted)
  } catch (error) {
    console.error('[auth] reading a certificate failed:', error instanceof Error ? error.message : 'unknown')
  }
}

export function noteCertificate (host: string, trusted: boolean, ...candidates: readonly Candidate[]): void {
  noteInto(certificates, host, trusted, candidates)
}
