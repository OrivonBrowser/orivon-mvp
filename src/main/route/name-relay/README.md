# `src/main/route/name-relay/`: looking up a site's address in Orivon, behind a system proxy

**What lives here.** The pieces of the name relay: the setting, off by default, that makes Orivon look up every site's
address itself while the system names a proxy, sending each lookup through that proxy and never from this computer, and
connect through the proxy to the address, so the proxy is asked for an address and never for a name. A connection Chromium
asks a loopback listener ([`../front.ts`](../front.ts), given an `open`) to make reaches `relay-opener.ts`, which asks the system
which proxy applies, has the name looked up through it and connects. Nothing here is wired to a session yet.

| File | Job | Durable or tied to Electron |
|---|---|---|
| `addresses.ts` | Which addresses a proxy is asked to connect to: IPv4 before IPv6, at most three, never one that means the proxy's own machine (loopback, unspecified, link-local); when the next address is worth a try | Durable: pure |
| `doh-message.ts` | The RFC 8484 message: one question per query, ID 0, an OPT record padded to a 128-byte block, no client subnet; an answer read along its CNAME chain (at most eight links) into addresses with the smallest TTL, or `NXDOMAIN`, no data, or failed (`SERVFAIL`, truncated, undecodable) | Durable: pure |
| `name-cache.ts` | What the relay remembers: keyed by name, family, provider and proxy entry, an hour at most, a minute for a name not found, one query in flight per key, 2,000 entries, never a failure | Durable: pure |
| `proxied-lookup.ts` | The lookup: a routed or onion name refused, an IP literal as it is, this computer's own mappings (`localOnly`), then a DNS-over-HTTPS query from an in-memory session set to the one proxy entry that will carry the connection, with no bypass and no direct fallback; one session per entry (`orivon-name-lookup-<n>`, four at most); every refusal one fixed word | Tied to Electron: it makes requests in sessions it is handed (`fetch`, `resolveHost`, `setProxy`) |
| `proxy-answer.ts` | The system's answer to "which proxy for this URL?" read into the proxies in order (`PROXY`, `HTTPS`, `SOCKS`, `SOCKS4`, `SOCKS5`, lists), a first `DIRECT`, or a reason to refuse; a `DIRECT` after a proxy is never among them; a SOCKS proxy on this computer at a port Tor listens on | Durable: pure |
| `relay-link.ts` | What the route controller takes of the relay: the config sessions that follow the system are set to while it is active, and the credentials its listener's proxy challenge is answered with. Types only | Durable: no `electron` import |
| `relay-failures.ts` | The fixed words for why a connection was not carried (`RefusalWord`, a superset of `LookupWord`), the `RelayRefusal` the listener answers with, the sentence for each, and the reason noted for a host and port for 30 seconds, which the load-error sheet reads | Durable: pure |
| `relay-opener.ts` | `front.ts`'s `open`: reads the host from the target's URL (the name Chromium dials and the one the system is asked about, not the text on the request line), refuses a routed or onion name first, asks the system's answer, looks the name up through the proxy it will leave by (`proxied-lookup.ts`'s answer: IPv4 first, connecting before IPv6 has answered), goes through the proxies in order, has the lookup forget a name every address of which failed, and bounds the connections it carries | Free of Electron, over the system's answer and the lookups it is handed |
| `name-relay-test-seam.ts` | In a test build only, the DNS-over-HTTPS address a suite names in place of the provider's | Durable: gated on the flag that compiles the developer grant |
| `upstream.ts` | One connection to an address: through an HTTP or HTTPS proxy (`CONNECT <address>:<port>` with `Host: <address>:<port>`), SOCKS5 or SOCKS4 by address, or straight to it; says whether to try the next address, the next proxy or neither | Tied to the operating system's network (`node:net`, `node:tls`, `socks`), not to Electron |

**What it depends on.** [`../own-proxy.ts`](../own-proxy.ts) (a lookup session sets its own proxy, so the shared identity
leaves it alone), [`../../privacy/secure-dns.ts`](../../privacy/secure-dns.ts) (the value that names the provider, as a type),
[`../../../protocols/builtin.ts`](../../../protocols/builtin.ts) and [`../../../broker/route/onion.ts`](../../../broker/route/onion.ts)
(which names are never looked up), [`../front.ts`](../front.ts) (`FrontTarget`, `FrontRefusal`),
[`../../../broker/route/socks5.ts`](../../../broker/route/socks5.ts) (the SOCKS5 provider), `node:net`, `node:tls`, the `socks` package
and `@dnsquery/dns-packet` (the message). `electron` for types only: the sessions are handed in.

**What it must never import.** An `electron` value, [`../route-controller.ts`](../route-controller.ts) or anything under
[`../../shell/`](../../shell/). Nothing here asks Chromium's resolver, this computer's DNS or the proxy by name for a site, and
nothing logs or reports a name, an address, a URL or a proxy entry: counts and the words of `LookupWord` and `RefusalWord` only.
The system's answer and every lookup reach `relay-opener.ts` as arguments, so a unit test drives it against fakes and real loopback
upstreams; for a first `DIRECT` answer the only name looked up is by the direct lookup it was handed.

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
