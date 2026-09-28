// What a session's certificate verify proc answers. Only a host the verifier
// serves is ever judged here; every other host keeps Chromium's own verdict.

/** Electron's verify-proc results: accept, reject, or use Chromium's verdict. */
export const ACCEPT = 0
export const REJECT = -2
export const CHROMIUM_VERDICT = -3

/**
 * A host the resolver rules send to the verifier (`routesToVerifier`) is
 * accepted only with the verifier's certificate of this run, matched by
 * fingerprint, and rejected otherwise, including before the verifier has
 * reported one. A process squatting the loopback port cannot present it
 * without the run's private key.
 */
export function verifierCertificateVerdict (hostname: string, fingerprint: string, expected: string | undefined, routesToVerifier: (host: string) => boolean): number {
  if (!routesToVerifier(hostname)) return CHROMIUM_VERDICT
  return expected !== undefined && fingerprint === expected ? ACCEPT : REJECT
}
