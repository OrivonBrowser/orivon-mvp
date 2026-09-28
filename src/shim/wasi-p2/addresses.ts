// WASI 0.2's socket addresses and error codes, and the names a program
// resolved. A program resolves a name and then connects to an address, while
// an app's grants usually name hosts: connecting by the name the program
// resolved lets the broker check the grant it would check for Node's
// net.connect(name), and re-resolve it itself. An address the program did
// not resolve is passed as it is, and the broker decides.

import type { OrivonNet } from '../../contracts/capability-api.js'

export type IpAddress =
  | { readonly tag: 'ipv4', readonly val: readonly [number, number, number, number] }
  | { readonly tag: 'ipv6', readonly val: readonly number[] }

export type IpSocketAddress =
  | { readonly tag: 'ipv4', readonly val: { readonly port: number, readonly address: readonly [number, number, number, number] } }
  | { readonly tag: 'ipv6', readonly val: { readonly port: number, readonly flowInfo: number, readonly address: readonly number[], readonly scopeId: number } }

export type IpAddressFamily = 'ipv4' | 'ipv6'

/** The part of orivon.net the socket interfaces reach. */
export type SocketNet = Pick<OrivonNet, 'connect' | 'listen' | 'udpBind' | 'lookup'>

export function formatAddress (address: IpAddress): string {
  if (address.tag === 'ipv4') return address.val.join('.')
  return address.val.map((part) => part.toString(16)).join(':')
}

export function parseAddress (text: string): IpAddress | undefined {
  const v4 = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(text)
  if (v4 !== null) {
    const parts = v4.slice(1).map(Number)
    return parts.every((part) => part <= 255) ? { tag: 'ipv4', val: parts as [number, number, number, number] } : undefined
  }
  if (!text.includes(':')) return undefined
  const [head = '', tail, extra] = text.replace(/^\[|\]$/g, '').split('::')
  if (extra !== undefined) return undefined
  const groups = (part: string): number[] | undefined => {
    if (part === '') return []
    const out: number[] = []
    for (const group of part.split(':')) {
      const embedded = parseAddress(group)
      if (embedded?.tag === 'ipv4') { const [a, b, c, d] = embedded.val; out.push((a << 8) | b, (c << 8) | d); continue }
      if (!/^[0-9a-f]{1,4}$/i.test(group)) return undefined
      out.push(parseInt(group, 16))
    }
    return out
  }
  const left = groups(head)
  const right = tail === undefined ? [] : groups(tail)
  if (left === undefined || right === undefined) return undefined
  const missing = 8 - left.length - right.length
  if (tail === undefined ? missing !== 0 : missing < 1) return undefined
  return { tag: 'ipv6', val: [...left, ...new Array<number>(tail === undefined ? 0 : missing).fill(0), ...right] }
}

export function socketAddressOf (address: IpAddress, port: number): IpSocketAddress {
  return address.tag === 'ipv4'
    ? { tag: 'ipv4', val: { port, address: address.val } }
    : { tag: 'ipv6', val: { port, flowInfo: 0, address: address.val, scopeId: 0 } }
}

export function addressOf (socket: IpSocketAddress): IpAddress {
  return socket.tag === 'ipv4' ? { tag: 'ipv4', val: socket.val.address } : { tag: 'ipv6', val: socket.val.address }
}

/** An address reported by orivon.net, as WASI's; an unparseable one reads as unspecified. */
export function reportedAddress (text: string, port: number, family: IpAddressFamily): IpSocketAddress {
  return socketAddressOf(parseAddress(text) ?? (family === 'ipv4' ? { tag: 'ipv4', val: [0, 0, 0, 0] } : { tag: 'ipv6', val: [0, 0, 0, 0, 0, 0, 0, 0] }), port)
}

export function isUnspecified (address: IpAddress): boolean {
  return address.val.every((part) => part === 0)
}

export function isLoopback (address: IpAddress): boolean {
  return address.tag === 'ipv4' ? address.val[0] === 127 : address.val.slice(0, 7).every((part) => part === 0) && address.val[7] === 1
}

/** Which interface a bind to `address` reaches: orivon.net binds loopback or every interface, never one address. */
export function scopeOf (address: IpAddress): 'local' | 'network' {
  return isLoopback(address) ? 'local' : 'network'
}

/** The names a program resolved, by the address each resolved to. */
export class ResolvedNames {
  readonly #names = new Map<string, string>()

  remember (name: string, address: IpAddress): void {
    this.#names.set(formatAddress(address), name)
  }

  /** What orivon.net is asked to reach for `address`: the name the program resolved it from, else the address. */
  hostFor (address: IpAddress): string {
    const text = formatAddress(address)
    return this.#names.get(text) ?? text
  }
}

/** An orivon.net rejection as the socket error code the component sees. */
export function socketErrorCode (error: unknown): string {
  const { code, platformCode } = typeof error === 'object' && error !== null ? error as { code?: unknown, platformCode?: unknown } : {}
  switch (platformCode) {
    case 'ECONNREFUSED': return 'connection-refused'
    case 'ECONNRESET': return 'connection-reset'
    case 'ECONNABORTED': return 'connection-aborted'
    case 'EADDRINUSE': return 'address-in-use'
    case 'EADDRNOTAVAIL': return 'address-not-bindable'
    case 'EHOSTUNREACH': case 'ENETUNREACH': return 'remote-unreachable'
    case 'ETIMEDOUT': return 'timeout'
  }
  switch (code) {
    case 'denied': return 'access-denied'
    case 'unreachable': return 'remote-unreachable'
    case 'timeout': return 'timeout'
    case 'reset': return 'connection-reset'
    case 'limit': return 'new-socket-limit'
    case 'invalid': return 'invalid-argument'
    case 'notFound': return 'name-unresolvable'
    case 'closed': return 'invalid-state'
    default: return 'unknown'
  }
}
