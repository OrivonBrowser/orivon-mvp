// What the address bar may claim about a tab's connection. Decided in main from the tab's real URL, never
// from anything a page says, and only for content the tab fetched itself over http or https.

/** `secure`: live https. `insecure`: plain http to a public host. `local`: plain http to this machine.
 * `none`: anything the lock or the warning would misdescribe. */
export type Connection = 'secure' | 'insecure' | 'local' | 'none'

export interface ConnectionInput {
  /** The URL the tab loaded. */
  readonly url: string
  /** What the person reads: a gateway address differs from `url` in scheme. */
  readonly displayUrl: string
  /** A registered app's tab, whose page Orivon serves from its cache. */
  readonly appTab: boolean
  /** One of the shell's own pages. */
  readonly internal: boolean
  /** The host is one a protocol gateway serves: the TLS under it is the gateway's, not the content's. */
  readonly served?: boolean
  /** The page is the error page of a load that failed: it carries the address that failed, and nothing was secured. */
  readonly failed?: boolean
}

function parse (value: string): URL | undefined {
  try {
    return new URL(value)
  } catch {
    return undefined
  }
}

/** `localhost`, any `.localhost` name, 127.0.0.0/8 and ::1: a connection that never leaves the machine. */
export function isLoopbackHost (hostname: string): boolean {
  const host = hostname.toLowerCase().replace(/^\[|\]$/g, '')
  if (host === 'localhost' || host.endsWith('.localhost') || host === '::1') return true
  return /^127(\.\d{1,3}){3}$/.test(host)
}

export function connectionOf (input: ConnectionInput): Connection {
  if (input.internal || input.appTab || input.served === true || input.failed === true) return 'none'
  const real = parse(input.url)
  const shown = parse(input.displayUrl)
  if (real === undefined || shown === undefined) return 'none'
  // A gateway address is shown under another scheme or host than the one loaded; the lock would be the gateway's.
  if (shown.protocol !== real.protocol || shown.hostname !== real.hostname) return 'none'
  if (real.protocol === 'https:') return 'secure'
  if (real.protocol !== 'http:') return 'none'
  return isLoopbackHost(real.hostname) ? 'local' : 'insecure'
}
