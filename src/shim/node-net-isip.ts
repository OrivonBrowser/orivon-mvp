// node:net's isIP/isIPv4/isIPv6, needed for reasons unrelated to sockets --
// see this file's callers. k-rpc-socket (underneath bittorrent-dht) calls
// isIP(peer.host) before every query to decide whether a peer address needs
// a DNS lookup first; node-dgram-socket.ts calls it to pick a Datagram's
// `family` field for orivon.net.udpBind's contract. Both need the same
// answer, so this is the one place that computes it (Rule 3).

const IPV4_PATTERN = /^(25[0-5]|2[0-4][0-9]|[01]?[0-9][0-9]?)(\.(25[0-5]|2[0-4][0-9]|[01]?[0-9][0-9]?)){3}$/

// A composite of every documented IPv6 textual form -- eight full groups,
// the "::" zero-run compression at any position, a trailing IPv4-mapped
// dotted-quad, and a zone-id suffix (fe80::1%eth0). Long because IPv6's own
// grammar is, not because it could be shortened -- see this file's header.
const IPV6_PATTERN = new RegExp(
  '^(' +
  '([0-9a-fA-F]{1,4}:){7}[0-9a-fA-F]{1,4}|' +
  '([0-9a-fA-F]{1,4}:){1,7}:|' +
  '([0-9a-fA-F]{1,4}:){1,6}:[0-9a-fA-F]{1,4}|' +
  '([0-9a-fA-F]{1,4}:){1,5}(:[0-9a-fA-F]{1,4}){1,2}|' +
  '([0-9a-fA-F]{1,4}:){1,4}(:[0-9a-fA-F]{1,4}){1,3}|' +
  '([0-9a-fA-F]{1,4}:){1,3}(:[0-9a-fA-F]{1,4}){1,4}|' +
  '([0-9a-fA-F]{1,4}:){1,2}(:[0-9a-fA-F]{1,4}){1,5}|' +
  '[0-9a-fA-F]{1,4}:((:[0-9a-fA-F]{1,4}){1,6})|' +
  ':((:[0-9a-fA-F]{1,4}){1,7}|:)|' +
  'fe80:(:[0-9a-fA-F]{0,4}){0,4}%[0-9a-zA-Z]+|' +
  '::(ffff(:0{1,4})?:)?((25[0-5]|(2[0-4]|1?[0-9])?[0-9])\\.){3}(25[0-5]|(2[0-4]|1?[0-9])?[0-9])|' +
  '([0-9a-fA-F]{1,4}:){1,4}:((25[0-5]|(2[0-4]|1?[0-9])?[0-9])\\.){3}(25[0-5]|(2[0-4]|1?[0-9])?[0-9])' +
  ')$'
)

export function isIPv4 (input: string): boolean {
  return IPV4_PATTERN.test(input)
}

export function isIPv6 (input: string): boolean {
  return IPV6_PATTERN.test(input)
}

/** Matches node:net's isIP: 4, 6, or 0 for neither -- a hostname needs a lookup. */
export function isIP (input: string): 0 | 4 | 6 {
  if (isIPv4(input)) return 4
  if (isIPv6(input)) return 6
  return 0
}
