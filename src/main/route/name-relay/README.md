# `src/main/route/name-relay/`: connecting a site's name to an address through the system's proxy

**What lives here.** The part of the name relay that takes a connection Chromium asked a loopback listener ([`../front.ts`](../front.ts), given an
`open`) to make: it asks the system which proxy applies to the URL, looks the name up through that proxy, and connects to the address through it,
so the proxy is asked for an address and never for a name. [`relay-link.ts`](relay-link.ts) is what the route controller takes of it. No relay
runs in this build: nothing starts a listener with these files, so no session is pointed at one.

| File | Job | Durable or tied to Electron |
|---|---|---|
| `relay-link.ts` | Types only: the config sessions that follow the system take while the relay is active, and the credentials its listener's challenge is answered with | Durable |
| `proxy-answer.ts` | The system's answer to "which proxy for this URL?" read into the proxies in order (`PROXY`, `HTTPS`, `SOCKS`, `SOCKS4`, `SOCKS5`, lists), a first `DIRECT`, or a reason to refuse; a `DIRECT` after a proxy is never among them; a SOCKS proxy on this computer at a port Tor listens on | Durable: pure |
| `addresses.ts` | Which addresses a proxy is asked to connect to: IPv4 before IPv6, at most three, never one that means the proxy's own machine (loopback, unspecified, link-local); when the next address is worth a try | Durable: pure |
| `relay-failures.ts` | The fixed words for why a connection was not carried (`RefusalWord`), the `RelayRefusal` the listener answers with, the sentence for each, and the reason noted for a host and port for 30 seconds, which the load-error sheet reads | Durable: pure |
| `upstream.ts` | One connection to an address: through an HTTP or HTTPS proxy (`CONNECT <address>:<port>` with `Host: <address>:<port>`), SOCKS5 or SOCKS4 by address, or straight to it; says whether to try the next address, the next proxy or neither | Tied to the operating system's network (`node:net`, `node:tls`, `socks`), not to Electron |
| `relay-opener.ts` | `front.ts`'s `open`: refuses a routed or onion name first, asks the system's answer, looks the name up through the proxy it will leave by (IPv4 and IPv6 together, connecting on the first answer), goes through the proxies in order, and bounds the connections it carries | Free of Electron, over the system's answer and the lookups it is handed |
| `doh-message.ts` | The RFC 8484 message: one question per query, ID 0, an OPT record padded to a 128-byte block, no client subnet; an answer read along its CNAME chain (at most eight links) into addresses with the smallest TTL, or `NXDOMAIN`, no data, or failed (`SERVFAIL`, truncated, undecodable) | Durable: pure |
| `name-cache.ts` | What the relay remembers: keyed by name, family, provider and proxy entry, an hour at most, a minute for a name not found, one query in flight per key, 2,000 entries, never a failure | Durable: pure |
| `proxied-lookup.ts` | The lookup: a routed or onion name refused, an IP literal as it is, this computer's own mappings (`localOnly`), then a DNS-over-HTTPS query from an in-memory session set to the one proxy entry that will carry the connection, with no bypass and no direct fallback; one session per entry (`orivon-name-lookup-<n>`, four at most); every refusal one fixed word | Tied to Electron: it makes requests in sessions it is handed (`fetch`, `resolveHost`, `setProxy`) |
| `name-relay-test-seam.ts` | In a test build only, the DNS-over-HTTPS address a suite names in place of the provider's | Durable: gated on the flag that compiles the developer grant |

**What it depends on.** [`../front.ts`](../front.ts) (`FrontTarget`, `FrontRefusal`), [`../own-proxy.ts`](../own-proxy.ts) (a lookup session sets its own proxy, so
the shared identity leaves it alone), [`../../privacy/secure-dns.ts`](../../privacy/secure-dns.ts) (the value that names the provider, as a type),
[`../../../broker/route/socks5.ts`](../../../broker/route/socks5.ts) (the SOCKS5 provider), [`../../../broker/route/onion.ts`](../../../broker/route/onion.ts),
[`../../../protocols/builtin.ts`](../../../protocols/builtin.ts) (which suffixes the verifier serves), `node:net`, `node:tls`, the `socks` package and
`@dnsquery/dns-packet` (the message).

**What it must never import.** An Electron value (a type is fine). The system's answer and every lookup are handed in, so a unit test drives the opener
against fakes and real loopback upstreams. Nothing here looks a name up on its own: a name reaches a lookup the opener was handed, or, for a first
`DIRECT` answer, the direct lookup it was handed.

**Owner stream.** `broker`.

## Design notes

**A lookup that cannot be made through the proxy fails the load; it never falls back.** Whether a lookup fails is the network's
choice, so a fallback to the proxy's own lookup, to this computer's DNS or to a second provider would hand every name back to
whoever made the first fail. The provider is the one the Secure DNS setting names (Quad9 for `off` and `automatic`), and the only
one asked.

**The query is sent from a session of the relay's own, never the system-proxy session or `resolveHost`.** The session that follows
the system could send a query direct when a proxy script says so, and `resolveHost` makes Chromium send its own query straight to
the provider whatever the session's proxy. A session on `fixed_servers` with one proxy and no bypass list has no direct road.

**Through SOCKS4 the server is named by address.** Chromium looks a name up on this computer before a SOCKS4 connection, so the
URL is `https://9.9.9.9/dns-query` (or `https://1.1.1.1/dns-query`), whose certificate lists the address. HTTP, HTTPS and SOCKS5
carry the name to the proxy, which looks up only the DNS server's own name.

**A proxy entry is checked before it becomes proxy rules.** Rules take `;` and `,` between entries and accept `direct://`, so a
host that carried one would add a direct road; only a name or an IP literal and a port are accepted.
