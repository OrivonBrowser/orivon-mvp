// The key a site's icon is kept under: the host of the address the person sees. Pure, so the tab that delivers an icon
// and the listing that reads it derive the same key.
const ICON_SCHEMES = new Set(['http:', 'https:', 'ipfs:', 'ipns:'])

/** The host of `address`, lower-cased, or null when a page at that address is not kept in history. */
export function faviconHost (address: string): string | null {
  try {
    const url = new URL(address)
    return ICON_SCHEMES.has(url.protocol) && url.hostname !== '' ? url.hostname : null
  } catch {
    return null
  }
}
