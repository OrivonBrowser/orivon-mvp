// Which addresses the relay asks a proxy to connect to, in which order, and which it never sends upstream. Pure over the
// strings it is handed.

import { BlockList, isIP } from 'node:net'

/** How many addresses of one name the relay tries before it gives up. */
export const MAX_ADDRESSES = 3

/**
 * What a proxy would reach on its own machine: loopback, the unspecified address, link-local (cloud metadata lives there),
 * `::/96` (the old IPv4-compatible form, which holds `::1` and `::`), and the same addresses written as IPv4-mapped IPv6.
 * Private ranges are not here: an intranet site behind a VPN's proxy is a real case.
 */
const INSIDE = new BlockList()
INSIDE.addSubnet('0.0.0.0', 8, 'ipv4')
INSIDE.addSubnet('127.0.0.0', 8, 'ipv4')
INSIDE.addSubnet('169.254.0.0', 16, 'ipv4')
INSIDE.addSubnet('::', 96, 'ipv6')
INSIDE.addSubnet('fe80::', 10, 'ipv6')

/** Whether `address`, an IP literal, is one the relay never asks a proxy to connect to. */
export function isInside (address: string): boolean {
  const family = isIP(address)
  return family !== 0 && INSIDE.check(address, family === 4 ? 'ipv4' : 'ipv6')
}

export interface OrderedAddresses {
  readonly usable: readonly string[]
  /** How many were left out for being inside, so that "nothing but inside addresses" can be told from "no address". */
  readonly inside: number
}

/** The IP literals of `addresses`, each once, in the order given. */
function distinct (addresses: readonly string[]): string[] {
  return [...new Set(addresses.filter((address) => isIP(address) !== 0))]
}

/** `addresses` as a proxy is asked for them: no inside address, IPv4 before IPv6 (the proxy's reach is what counts, not this computer's), at most `limit`. */
export function orderForProxy (addresses: readonly string[], limit = MAX_ADDRESSES): OrderedAddresses {
  const all = distinct(addresses)
  const outside = all.filter((address) => !isInside(address))
  const ordered = [...outside.filter((address) => isIP(address) === 4), ...outside.filter((address) => isIP(address) === 6)]
  return { usable: ordered.slice(0, limit), inside: all.length - outside.length }
}

/** `addresses` for a connection the system sends outside any proxy: the resolver's order and every address, as Chromium's own direct connection would, at most three. */
export function keepResolverOrder (addresses: readonly string[]): string[] {
  return distinct(addresses).slice(0, MAX_ADDRESSES)
}

/** Whether a proxy's status to a CONNECT says that address could not be reached, so that the next is worth a try; a 403 or 407 ends the attempt. */
export function nextAddressAfterStatus (status: number): boolean {
  return status === 502 || status === 503 || status === 504
}

/** Whether the word a SOCKS proxy gives for a refused connect (the `socks` package's name for the reply) says the address was unreachable or refused. */
export function nextAddressAfterSocks (reply: string): boolean {
  return reply === 'NetworkUnreachable' || reply === 'HostUnreachable' || reply === 'ConnectionRefused' || reply === 'Failed'
}
