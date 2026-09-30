// The one place the verify proc tells the viewer what a connection presented. It runs inside the session's
// certificate verify proc, which answers every TLS connection and must never be slowed or broken by this.
import { CertificateCache } from './certificate-cache.js'
import { chainOf, sha256Of } from './certificate-view.js'
import type { CertificateLike } from './certificate-view.js'

/** Every host's certificate in this process; the viewer reads it for the page a tab is on. */
export const certificates = new CertificateCache()

type Candidate = CertificateLike | null | undefined

const readable = (certificate: Candidate): certificate is CertificateLike => typeof certificate?.data === 'string' && certificate.data !== ''

/** Records the first certificate that can be read: the validated one, which has its issuers, else the one presented. */
export function noteInto (cache: CertificateCache, host: string, candidates: readonly Candidate[]): void {
  try {
    const certificate = candidates.find(readable)
    if (certificate === undefined) return
    // A host that keeps presenting the same certificate costs one hash, not a walk of the chain.
    if (cache.leafOf(host) === sha256Of(certificate.data)) return
    cache.set(host, chainOf(certificate))
  } catch (error) {
    console.error('[auth] reading a certificate failed:', error instanceof Error ? error.message : 'unknown')
  }
}

export function noteCertificate (host: string, ...candidates: readonly Candidate[]): void {
  noteInto(certificates, host, candidates)
}
