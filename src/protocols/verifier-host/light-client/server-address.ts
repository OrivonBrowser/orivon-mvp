// What an Ethereum server the person types in Settings must look like, and why one is refused, in words the Settings page can
// show. Also the one rule for "could this host be on the internet", shared with the CCIP fetch's checks. Pure: no I/O.

import { classifyAddress, isPublicUnicast } from '../../../broker/policy/address.js'
import { BUILTIN_ADDRESSES } from '../../builtin.js'
import { isLocalLiteral } from './endpoint-mask.js'

/** Names that only mean something on a local network: a tunnel's far end would resolve them on its own side. */
export const LOCAL_NAME = /\.(?:local|lan|internal|home\.arpa|corp|home|intranet|private)$/i

/** `.invalid` never resolves (RFC 2606): the names Helios is given for its lanes are under it. */
const NEVER_RESOLVES = /\.invalid$/i

/** The longest address a setting holds. */
export const MAX_ADDRESS_LENGTH = 2048

/** Whether `host` is a name that reaches this computer or Orivon's own verifier: `localhost`, anything under it, and a protocol's host. */
export function namesThisComputer (host: string): boolean {
  return host === 'localhost' || host.endsWith('.localhost') || BUILTIN_ADDRESSES.routesToVerifier(host)
}

/** Whether a server's host, address literal or name, could be on the internet: no loopback, private, link-local or reserved literal, and no name that is this computer's, a local network's, one that never resolves, a single label or a spelling with a trailing dot. A name is judged by its spelling, never by what it resolves to, so one that resolves to a private address is taken (T12). */
export function isInternetHost (host: string): boolean {
  const bare = host.replace(/^\[|\]$/g, '')
  if (classifyAddress(bare) !== 'unparseable') return isPublicUnicast(bare)
  return !namesThisComputer(bare) && !LOCAL_NAME.test(bare) && !NEVER_RESOLVES.test(bare) && bare.includes('.') && !bare.endsWith('.')
}

/** Which of the light client's two servers an address is for. The beacon server's address gets the light client's own paths added after it, so it holds no query. */
export type ServerKind = 'execution' | 'beacon'

const HOME_HINT = 'To use a computer on your home network, type its address, like http://192.168.1.20:8545.'

/**
 * Why `text` cannot be the address of a server, as a sentence for the person; undefined when it can. Never repeats any part
 * of `text`, because an address may hold a key. A server on this computer or a home network is `localhost` or a loopback or
 * private address literal over http or https; any other is on the internet and is https on the usual port.
 */
export function serverAddressProblem (text: string, kind: ServerKind): string | undefined {
  if (text.length > MAX_ADDRESS_LENGTH) return 'That address is too long.'
  if (/\s/.test(text)) return 'An address has no spaces in it.'
  let url: URL
  try {
    url = new URL(text)
  } catch {
    return 'That is not an address. Start it with https://, or http:// for a computer of yours.'
  }
  if (url.protocol !== 'https:' && url.protocol !== 'http:') return 'An address starts with https://, or http:// for a computer of yours.'
  if (url.username !== '' || url.password !== '') return 'Leave the user name and password out of the address; a key goes in the path or after a ?.'
  if (url.hash !== '') return 'Leave the # and what follows it out of the address.'
  if (kind === 'beacon' && url.search !== '') return 'A beacon server\'s address cannot hold a ? part, because the light client adds its own paths after it.'
  const host = url.hostname.replace(/^\[|\]$/g, '')
  if (isLocalLiteral(url.hostname)) return undefined
  if (classifyAddress(host) !== 'unparseable' ? !isPublicUnicast(host) : !isInternetHost(host)) {
    return classifyAddress(host) === 'unparseable'
      ? `That name is not a server on the internet. ${HOME_HINT}`
      : `That is not an address on this computer, a home network or the internet. ${HOME_HINT}`
  }
  if (url.protocol !== 'https:') return `An address on the internet must start with https://, so that a key does not travel in the clear. ${HOME_HINT}`
  if (url.port !== '') return 'An address on the internet must use the usual https port (443): leave the port out.'
  return undefined
}
