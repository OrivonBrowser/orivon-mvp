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

/**
 * The line logged when a verifier-served host's certificate is refused: the fingerprint main held, the one it was
 * shown, and what the host was doing. Such a refusal is never expected once the host listens, so the line is what
 * explains one in a test failure or a sent report. Fingerprints are cut to their first 16 characters: enough to tell
 * two apart, and the certificate is the run's own, not the site's.
 */
export function refusalNote (hostname: string, presented: string, expected: string | undefined, hostState: string): string {
  const short = (fingerprint: string): string => fingerprint.replace(/^sha256\//, '').slice(0, 16)
  const held = expected === undefined ? 'no verifier certificate was known' : `the verifier's is ${short(expected)}`
  return `[verifier] refused certificate ${short(presented)} for ${hostname}: ${held} (host ${hostState})`
}
