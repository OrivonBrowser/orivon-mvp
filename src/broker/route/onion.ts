// What an onion address is, and why a route that is not Tor refuses one. Pure: no `electron`, no I/O.

/** The words of a refusal, for an error an app reads and the sheet over a tab: where an onion address can be opened. */
export const ONION_NEEDS_TOR = 'An onion address opens only through a Tor tunnel, so its name is not looked up. Set your own SOCKS5 address in Settings, then Tunnels, and send this site through it.'

/** The ideographic and fullwidth stops the URL parser reads as a dot. */
const OTHER_DOTS = /[。．｡]/g

/** A name under `.onion` (RFC 7686), in any case and with the root dot, or `onion` itself. */
export function isOnionHost (host: string): boolean {
  const name = host.toLowerCase().replace(OTHER_DOTS, '.').replace(/\.$/, '')
  return name === 'onion' || name.endsWith('.onion')
}

/** Whether an address names an onion service by its host; an address with no host, or one that cannot be read, does not. */
export function isOnionUrl (url: string): boolean {
  try {
    return isOnionHost(new URL(url).hostname)
  } catch {
    return false
  }
}
