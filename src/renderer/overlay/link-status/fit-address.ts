// The text of the link bubble, fitted to its room without hiding what the person must see: where the address goes is its
// host, and a host is read from its end (`paypal.com.verify.evil.example` is evil.example). A line that ends in an ellipsis
// as CSS cuts it would show the beginning of a long host and hide the end, so the text is cut here: the path first, then
// the middle of the host. Pure: `fits` is the page's own measure of a candidate.

const ELLIPSIS = '…'

/** The scheme (a `blob:` address holds another one), the host and port, and what follows them. */
const PARTS = /^((?:blob:|filesystem:)?[a-z][a-z0-9+.-]*:\/\/)([^/?#]*)([\s\S]*)$/i

const isHigh = (code: number): boolean => code >= 0xd800 && code <= 0xdbff
const isLow = (code: number): boolean => code >= 0xdc00 && code <= 0xdfff

/** The first `count` characters, never ending on half of one that takes two code units. */
function head (text: string, count: number): string {
  const cut = text.slice(0, count)
  return cut.length > 0 && isHigh(cut.charCodeAt(cut.length - 1)) ? cut.slice(0, -1) : cut
}

/** The last `count` characters, never starting on half of one that takes two code units. */
function tail (text: string, count: number): string {
  const cut = count <= 0 ? '' : text.slice(-count)
  return cut.length > 0 && isLow(cut.charCodeAt(0)) ? cut.slice(1) : cut
}

/** The largest `n` from `low` to `high` that `fits`, or nothing when not even `low` does. `fits` never goes from false to true as `n` grows. */
function largest (low: number, high: number, fits: (n: number) => boolean): number | undefined {
  if (low > high || !fits(low)) return undefined
  let best = low
  let top = high
  while (best < top) {
    const middle = Math.ceil((best + top) / 2)
    if (fits(middle)) best = middle
    else top = middle - 1
  }
  return best
}

/** `text` as it is shown in a room `fits` measures: whole when it fits, else with its path cut, else with the middle of its host cut. */
export function fitAddress (text: string, fits: (candidate: string) => boolean): string {
  if (fits(text)) return text
  const match = PARTS.exec(text)
  const [, scheme = '', host = '', rest = ''] = match ?? []
  if (match === null || host === '') {
    // No host to keep: the end of the address is the part that goes.
    const kept = largest(0, text.length, (count) => fits(head(text, count) + ELLIPSIS))
    return head(text, kept ?? 0) + ELLIPSIS
  }

  const origin = scheme + host
  if (rest !== '') {
    const pathKept = largest(rest.startsWith('/') ? 1 : 0, rest.length - 1, (count) => fits(origin + head(rest, count) + ELLIPSIS))
    if (pathKept !== undefined) return origin + head(rest, pathKept) + ELLIPSIS
    if (fits(origin)) return origin
  }

  // The host itself is too long: the end of it stays, with as much of its beginning as there is room for.
  const hostKept = largest(1, host.length - 1, (count) => fits(cutHost(scheme, host, count)))
  if (hostKept !== undefined) return cutHost(scheme, host, hostKept)
  // Not even the scheme with a character of each end: the end of the host, with no scheme.
  const endKept = largest(1, host.length, (count) => fits(endOf(host, count)))
  return endOf(host, endKept ?? 1)
}

/** The scheme, a third of `count` characters of the beginning of the host, an ellipsis and two thirds of the end of it: the end gets the most, it names the site. */
function cutHost (scheme: string, host: string, count: number): string {
  const end = Math.ceil(count * 2 / 3)
  return scheme + head(host, count - end) + ELLIPSIS + tail(host, end)
}

function endOf (host: string, count: number): string {
  return count >= host.length ? host : ELLIPSIS + tail(host, count)
}
