// What the system's answer to "which proxy for this URL?" (T20's `resolveProxy` string) comes to for the name relay: the
// proxies it may use, in order, a first `DIRECT`, or a reason to refuse. Pure: no `electron`.

import { isIP } from 'node:net'
import type { ProxyEntry } from './proxied-lookup.js'

export type ProxyAnswer =
  /** The system sends this connection outside any proxy. */
  | { readonly kind: 'direct' }
  /** Proxies to try in order. A `DIRECT` after one is not among them: it would send the name and the connection outside the proxy the system put first. */
  | { readonly kind: 'proxies', readonly entries: readonly ProxyEntry[] }
  /** Every entry is of a kind the relay cannot speak. */
  | { readonly kind: 'refused' }
  /** Not an answer Chromium gives, so Orivon cannot tell what the system says. */
  | { readonly kind: 'junk' }

const SCHEMES: Readonly<Record<string, { readonly scheme: ProxyEntry['scheme'], readonly port: number } | 'quic'>> = {
  PROXY: { scheme: 'http', port: 80 },
  HTTP: { scheme: 'http', port: 80 },
  HTTPS: { scheme: 'https', port: 443 },
  SOCKS: { scheme: 'socks4', port: 1080 },
  SOCKS4: { scheme: 'socks4', port: 1080 },
  SOCKS5: { scheme: 'socks5', port: 1080 },
  QUIC: 'quic'
}

const HOST_NAME = /^[A-Za-z0-9._~-]+$/

function hostAndPort (text: string, defaultPort: number): { host: string, port: number } | undefined {
  let host = text
  let portText: string | undefined
  if (text.startsWith('[')) {
    const close = text.indexOf(']')
    if (close === -1) return undefined
    host = text.slice(1, close)
    const rest = text.slice(close + 1)
    if (rest !== '') {
      if (!rest.startsWith(':')) return undefined
      portText = rest.slice(1)
    }
    if (isIP(host) !== 6) return undefined
  } else {
    const colon = text.indexOf(':')
    if (colon !== -1) {
      host = text.slice(0, colon)
      portText = text.slice(colon + 1)
    }
    if (!HOST_NAME.test(host)) return undefined
  }
  if (portText === undefined) return { host, port: defaultPort }
  const port = /^\d{1,5}$/.test(portText) ? Number(portText) : 0
  return port >= 1 && port <= 65_535 ? { host, port } : undefined
}

/** Reads `answer` as Chromium writes it: entries separated by `;`, each `DIRECT` or a scheme and `host:port`. */
export function parseProxyAnswer (answer: string): ProxyAnswer {
  const entries: ProxyEntry[] = []
  let proxiesSeen = 0
  for (const part of answer.split(';')) {
    const text = part.trim()
    if (text === '') continue
    if (text.toUpperCase() === 'DIRECT') {
      if (proxiesSeen === 0) return { kind: 'direct' }
      break
    }
    const fields = /^(\S+)\s+(\S+)$/.exec(text)
    const scheme = fields === null ? undefined : SCHEMES[(fields[1] ?? '').toUpperCase()]
    if (fields === null || scheme === undefined) return { kind: 'junk' }
    const target = hostAndPort(fields[2] ?? '', scheme === 'quic' ? 443 : scheme.port)
    if (target === undefined) return { kind: 'junk' }
    proxiesSeen += 1
    if (scheme !== 'quic') entries.push({ scheme: scheme.scheme, ...target })
  }
  if (proxiesSeen === 0) return { kind: 'junk' }
  return entries.length === 0 ? { kind: 'refused' } : { kind: 'proxies', entries }
}

const TOR_PORTS: ReadonlySet<number> = new Set([9050, 9150])

function onThisComputer (host: string): boolean {
  const name = host.toLowerCase().replace(/\.$/, '')
  return name === 'localhost' || name === '::1' || name.startsWith('127.')
}

/**
 * Whether `entry` is a SOCKS proxy on this computer at a port Tor listens on by default. Every lookup would travel on that one
 * connection to one DNS provider and be linked across sites, where Tor looks each name up at the exit of that site's own circuit.
 * Provisional: an anonymity network on other ports cannot be recognised.
 */
export function onAnonymityPort (entry: ProxyEntry): boolean {
  return (entry.scheme === 'socks5' || entry.scheme === 'socks4') && TOR_PORTS.has(entry.port) && onThisComputer(entry.host)
}
