// What a session's certificate verify proc answers. Only a `.eth` host is
// ever judged here; every other host keeps Chromium's own verdict.

/** Electron's verify-proc results: accept, reject, or use Chromium's verdict. */
export const ACCEPT = 0
export const REJECT = -2
export const CHROMIUM_VERDICT = -3

/**
 * A `.eth` host is accepted only with the verifier's certificate of this
 * run, matched by fingerprint, and rejected otherwise, including before the
 * verifier has reported one. A process squatting the loopback port cannot
 * present it without the run's private key.
 */
export function ethCertificateVerdict (hostname: string, fingerprint: string, expected: string | undefined): number {
  if (!hostname.toLowerCase().endsWith('.eth')) return CHROMIUM_VERDICT
  return expected !== undefined && fingerprint === expected ? ACCEPT : REJECT
}
