// What a report's log says of an address: the scheme and the kind of site, never the site's name, its path, query or fragment,
// which name the page a person was on and can hold a token. Pure.
import { INTERNAL_SCHEME } from '../pages/internal-pages.js'
import { SHELL_SCHEME } from '../shell/shell-session.js'
import { MASK } from '../../protocols/verifier-host/light-client/endpoint-mask.js'

/** `scheme://` and what follows it up to a space or a quote. The scheme is at most 32 characters, so a long run of letters and dots cannot make the search quadratic. */
const ADDRESS = /(?<![A-Za-z0-9+.-])([A-Za-z][A-Za-z0-9+.-]{0,31}):\/\/([^\s'"<>`]+)/g

const CLOSER_OF: Readonly<Record<string, string>> = { ')': '(', ']': '[', '}': '{' }

/** The pages Orivon draws itself: their host names are page names, never a site the person visited. */
const OWN_SCHEMES: ReadonlySet<string> = new Set([INTERNAL_SCHEME, SHELL_SCHEME])

/** A name this computer answers for, kept whole with its port: which local service failed is what a report is read for. */
const LOOPBACK = /^(?:localhost|127(?:\.\d{1,3}){3}|\[::1\])$/i
const ADDRESS_LITERAL = /^(?:\d{1,3}(?:\.\d{1,3}){3}|\[.*\])$/
/** What may stand as the last label of a host and be kept: short and made of a name's characters, so `.eth`, `.onion` and `.com` stay and a content identifier or a key does not. */
const KIND_LABEL = /^[A-Za-z][A-Za-z0-9-]{0,23}$/

const count = (text: string, char: string): number => text.split(char).length - 1

/** The sentence's punctuation, or a bracket that closes none opened inside the address, at the end of what the pattern took: `(https://a.example/x)` ends before its `)`, and `http://[::1]` keeps its `]`. */
function trailing (body: string): string {
  let end = body.length
  while (end > 0) {
    const last = body.charAt(end - 1)
    const opener = CLOSER_OF[last]
    const closesNothing = opener !== undefined && count(body.slice(0, end), last) > count(body.slice(0, end), opener)
    if (!',.;:!?'.includes(last) && !closesNothing) break
    end--
  }
  return body.slice(end)
}

/** The host and port of an authority, without the credentials. */
function hostAndPort (authority: string): { host: string, port: string } {
  const hostPort = authority.slice(authority.lastIndexOf('@') + 1)
  const bracketed = /^(\[[^\]]*\])(?::(\d*))?$/.exec(hostPort)
  if (bracketed !== null) return { host: bracketed[1] ?? '', port: bracketed[2] ?? '' }
  const colon = hostPort.lastIndexOf(':')
  return colon !== -1 && /^\d*$/.test(hostPort.slice(colon + 1)) ? { host: hostPort.slice(0, colon), port: hostPort.slice(colon + 1) } : { host: hostPort, port: '' }
}

/** What stands for the site: nothing for a file, whose host is a share's server or the `~` a home directory became; this computer's own host as it is, one of Orivon's own pages by its name, otherwise `••••` with the last label of the name (`••••.eth`), or `••••` alone for an address, a single label such as a content identifier, and a last label that is no kind. */
function shownSite (scheme: string, authority: string): string {
  if (scheme.toLowerCase() === 'file') return ''
  const { host, port } = hostAndPort(authority)
  if (host === '') return ''
  if (LOOPBACK.test(host)) return port === '' ? host : `${host}:${port}`
  if (OWN_SCHEMES.has(scheme.toLowerCase())) return host
  if (ADDRESS_LITERAL.test(host)) return MASK
  const labels = host.split('.')
  const last = labels.at(-1) ?? ''
  return labels.length > 1 && KIND_LABEL.test(last) ? `${MASK}.${last}` : MASK
}

/**
 * `text` with every `scheme://` address cut to its scheme and the kind of its site: `https://example.org/a?b=1` is
 * `https://••••.org/••••`, an onion address is `http://••••.onion/••••`, and a file address, which has no site, is
 * `file:///••••`. Credentials, port, path, query and fragment are gone, except a loopback address's host and port. An address
 * with nothing after its site is cut the same way, and one already cut is left as it is, so a second pass changes nothing. A
 * name or path that is not written as an address is not found.
 */
export function redactAddresses (text: string): string {
  return text.replace(ADDRESS, (_whole: string, scheme: string, body: string) => {
    const tail = trailing(body)
    const address = body.slice(0, body.length - tail.length)
    const end = address.search(/[/?#]/)
    const rest = end === -1 ? '' : address.slice(end)
    const site = shownSite(scheme, end === -1 ? address : address.slice(0, end))
    return `${scheme}://${site}${rest === '' || rest === '/' ? rest : `/${MASK}`}${tail}`
  })
}
