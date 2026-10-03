// The key a site's icon is kept under: the host of the address the person sees, with its port when it is not the
// scheme's usual one, since two servers on one machine are two sites. Pure, so the tab that delivers an icon and the
// listing that reads it derive the same key.
const ICON_SCHEMES = new Set(['http:', 'https:', 'ipfs:', 'ipns:'])

/** The host of `address`, lower-cased, with a port that is not the scheme's usual one, or null when a page at that
 * address is not kept in history. */
export function faviconHost (address: string): string | null {
  try {
    const url = new URL(address)
    return ICON_SCHEMES.has(url.protocol) && url.hostname !== '' ? url.host : null
  } catch {
    return null
  }
}

/** The icon history keeps for the site of `address`; null when none is kept. */
export function knownIcon (history: { faviconsFor: (hosts: readonly string[]) => Record<string, string> } | undefined, address: string): string | null {
  const host = faviconHost(address)
  if (history === undefined || host === null) return null
  try {
    return history.faviconsFor([host])[host] ?? null
  } catch {
    return null
  }
}
