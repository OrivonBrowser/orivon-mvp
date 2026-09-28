// tls.checkServerIdentity: Node's own algorithm (lib/tls.js), ported line
// for line so an app's custom identity check -- which usually starts by
// calling this one -- gets Node's exact answer, wildcard rules and error
// shape included. Pure: it reads a Node-shaped certificate and touches no
// socket.

import { isIP, isIPv4 } from './isip.js'

/** The fields of a Node peer certificate this check reads. */
export interface IdentityCertificate {
  readonly subject?: Readonly<Record<string, string | readonly string[]>> | undefined
  readonly subjectaltname?: string | undefined
}

export type AltnameError = Error & { code: 'ERR_TLS_CERT_ALTNAME_INVALID', reason: string, host: string, cert: unknown }

function altnameError (reason: string, host: string, cert: unknown): AltnameError {
  const error = new Error(`Hostname/IP does not match certificate's altnames: ${reason}`) as AltnameError
  error.code = 'ERR_TLS_CERT_ALTNAME_INVALID'
  error.reason = reason
  error.host = host
  error.cert = cert
  return error
}

function unfqdn (host: string): string {
  return host.replace(/[.]$/, '')
}

/** Lowercases A-Z only: String#toLowerCase is locale-sensitive, and Node avoids it here for that reason. */
function splitHost (host: string): string[] {
  return unfqdn(host).replace(/[A-Z]/g, (c) => String.fromCharCode(c.charCodeAt(0) + 32)).split('.')
}

function check (hostParts: readonly string[], pattern: string | undefined, wildcards: boolean): boolean {
  if (pattern === undefined || pattern === '') return false
  const patternParts = splitHost(pattern)
  if (hostParts.length !== patternParts.length) return false
  if (patternParts.includes('')) return false
  // IDNA U-labels, control characters and blanks never match.
  if (patternParts.some((part) => /[^\x21-\x7f]/u.test(part))) return false
  for (let i = hostParts.length - 1; i > 0; i -= 1) {
    if (hostParts[i] !== patternParts[i]) return false
  }
  const hostSubdomain = hostParts[0] ?? ''
  const patternSubdomain = patternParts[0] ?? ''
  const patternSubdomainParts = patternSubdomain.split('*')
  // No wildcard substitution inside an A-label (RFC 6125).
  if (patternSubdomainParts.length === 1 || patternSubdomain.includes('xn--')) return hostSubdomain === patternSubdomain
  if (!wildcards) return false
  if (patternSubdomainParts.length > 2) return false
  // `*.tld` is never allowed.
  if (patternParts.length <= 2) return false
  const [prefix = '', suffix = ''] = patternSubdomainParts
  if (prefix.length + suffix.length > hostSubdomain.length) return false
  return hostSubdomain.startsWith(prefix) && hostSubdomain.endsWith(suffix)
}

/** Node's jsonStringPattern: a quoted SAN entry is a JSON string literal. */
const JSON_STRING = /^"(?:[^"\\\u0000-\u001f]|\\(?:["\\/bfnrt]|u[0-9a-fA-F]{4}))*"/

function splitEscapedAltNames (altNames: string): string[] {
  const result: string[] = []
  let current = ''
  let offset = 0
  while (offset !== altNames.length) {
    const nextSep = altNames.indexOf(',', offset)
    const nextQuote = altNames.indexOf('"', offset)
    if (nextQuote !== -1 && (nextSep === -1 || nextQuote < nextSep)) {
      current += altNames.substring(offset, nextQuote)
      const match = JSON_STRING.exec(altNames.substring(nextQuote))
      if (match === null) throw Object.assign(new Error('Invalid subject alternative name string'), { code: 'ERR_TLS_CERT_ALTNAME_FORMAT' })
      current += JSON.parse(match[0]) as string
      offset = nextQuote + match[0].length
    } else if (nextSep !== -1) {
      current += altNames.substring(offset, nextSep)
      result.push(current)
      current = ''
      offset = nextSep + 2
    } else {
      current += altNames.substring(offset)
      offset = altNames.length
    }
  }
  result.push(current)
  return result
}

/** One spelling per address, so a SAN entry and a hostname compare equal whenever inet_pton would parse them to the same bytes. */
function canonicalizeIp (text: string): string | undefined {
  if (isIPv4(text)) return text.split('.').map((octet) => String(Number(octet))).join('.')
  if (isIP(text) !== 6 || text.includes('%')) return undefined
  let body = text.toLowerCase()
  const tail = body.slice(body.lastIndexOf(':') + 1)
  if (isIPv4(tail)) {
    const [a = 0, b = 0, c = 0, d = 0] = tail.split('.').map(Number)
    body = `${body.slice(0, body.length - tail.length)}${((a << 8) | b).toString(16)}:${((c << 8) | d).toString(16)}`
  }
  const [head = '', rest] = body.split('::')
  const left = head === '' ? [] : head.split(':')
  const right = rest === undefined || rest === '' ? [] : rest.split(':')
  const groups = rest === undefined ? left : [...left, ...Array<string>(8 - left.length - right.length).fill('0'), ...right]
  return groups.map((group) => Number.parseInt(group, 16).toString(16)).join(':')
}

/** Node's tls.checkServerIdentity: undefined when `cert` names `hostname`, otherwise the ERR_TLS_CERT_ALTNAME_INVALID error. */
export function checkServerIdentity (hostname: string, cert: IdentityCertificate): AltnameError | undefined {
  const subject = cert.subject
  const altNames = cert.subjectaltname
  const dnsNames: string[] = []
  const ips: Array<string | undefined> = []
  let host = String(hostname)

  if (altNames !== undefined && altNames !== '') {
    const split = altNames.includes('"') ? splitEscapedAltNames(altNames) : altNames.split(', ')
    for (const name of split) {
      if (name.startsWith('DNS:')) dnsNames.push(name.slice(4))
      else if (name.startsWith('IP Address:')) ips.push(canonicalizeIp(name.slice(11)))
    }
  }

  let valid = false
  let reason = 'Unknown reason'
  host = unfqdn(host)

  if (isIP(host) !== 0) {
    valid = ips.includes(canonicalizeIp(host))
    if (!valid) reason = `IP: ${host} is not in the cert's list: ${ips.join(', ')}`
  } else if (dnsNames.length > 0 || subject?.CN !== undefined) {
    const hostParts = splitHost(host)
    const wildcard = (pattern: string | undefined): boolean => check(hostParts, pattern, true)
    if (dnsNames.length > 0) {
      valid = dnsNames.some(wildcard)
      if (!valid) reason = `Host: ${host}. is not in the cert's altnames: ${altNames ?? ''}`
    } else {
      const cn = subject?.CN
      valid = Array.isArray(cn) ? cn.some(wildcard) : wildcard(cn as string | undefined)
      if (!valid) reason = `Host: ${host}. is not cert's CN: ${String(cn)}`
    }
  } else {
    reason = 'Cert does not contain a DNS name'
  }

  return valid ? undefined : altnameError(reason, host, cert)
}
