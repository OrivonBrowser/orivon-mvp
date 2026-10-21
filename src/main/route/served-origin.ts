// Whether an address is one Orivon's own nodes fetch and serve (a protocol's scheme, or a host the verifier answers for),
// and how a person reads it. Pure over the protocol registry, so a scheme added there is covered without a change here.
import { BUILTIN_ADDRESSES } from '../../protocols/builtin.js'

const HOST_PART = /^[a-z][a-z0-9+.-]*:\/\/[^/?#]+/u

/** The origin as a person reads it (`ipfs://name`), or undefined when Orivon does not serve `url`. */
export function servedOrigin (url: string): string | undefined {
  const target = BUILTIN_ADDRESSES.servedUrl(url) ?? url
  let parsed: URL
  try {
    parsed = new URL(target)
  } catch {
    return undefined
  }
  if ((parsed.protocol !== 'https:' && parsed.protocol !== 'http:') || !BUILTIN_ADDRESSES.routesToVerifier(parsed.hostname)) return undefined
  return HOST_PART.exec(BUILTIN_ADDRESSES.displayUrl(target))?.[0]
}
