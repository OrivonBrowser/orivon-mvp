// What a report's log says of an address: the scheme and the site, never the path, query or fragment, which name the page
// a person was on and can hold a token. Pure.
import { MASK } from '../../protocols/verifier-host/light-client/endpoint-mask.js'

/** `scheme://` and what follows it up to a space or a quote. The scheme is at most 32 characters, so a long run of letters and dots cannot make the search quadratic. */
const ADDRESS = /(?<![A-Za-z0-9+.-])([A-Za-z][A-Za-z0-9+.-]{0,31}):\/\/([^\s'"<>`]+)/g

const CLOSER_OF: Readonly<Record<string, string>> = { ')': '(', ']': '[', '}': '{' }

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

/** The host and port of an address's authority, without the credentials; what follows is the path, the query or the fragment. */
function split (body: string): { site: string, rest: string } {
  const at = body.search(/[/?#]/)
  const authority = at === -1 ? body : body.slice(0, at)
  return { site: authority.slice(authority.lastIndexOf('@') + 1), rest: at === -1 ? '' : body.slice(at) }
}

/**
 * `text` with every `scheme://` address cut after its site: `https://example.org/a?b=1` is `https://example.org/••••`, and a
 * file address, which has no site, is `file:///••••`. An address with nothing after its site is left as it is, and so is one
 * already cut, so a second pass changes nothing. A name or path that is not written as an address is not found.
 */
export function redactAddresses (text: string): string {
  return text.replace(ADDRESS, (_whole: string, scheme: string, body: string) => {
    const tail = trailing(body)
    const { site, rest } = split(body.slice(0, body.length - tail.length))
    return `${scheme}://${site}${rest === '' || rest === '/' ? rest : `/${MASK}`}${tail}`
  })
}
