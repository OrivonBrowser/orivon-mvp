/**
 * Every `.eth` host resolves to the verifier's loopback server, whose
 * certificate each session accepts by the run's fingerprint alone
 * (src/main/verifier/). A request to one reaches no host on the network, so
 * the public-address checks that guard every other install do not apply to
 * it: its host has no public address to check. Only `https:`; a developer
 * name over plain `http:` is never installed.
 */
export function servedByVerifier (url: string): boolean {
  try {
    const parsed = new URL(url)
    return parsed.protocol === 'https:' && parsed.hostname.endsWith('.eth')
  } catch {
    return false
  }
}
