# `src/main/route/name-relay/`: looking up a site's address in Orivon, behind a system proxy

**What lives here.** The pieces of the name relay: the setting, off by default, that makes Orivon look up every site's
address itself while the system names a proxy, sending each lookup through that proxy and never from this computer, and
connect through the proxy to the address. Nothing here is wired to a session yet.

| File | Job | Durable or tied to Electron |
|---|---|---|
| `doh-message.ts` | The RFC 8484 message: one question per query, ID 0, an OPT record padded to a 128-byte block, no client subnet; an answer read along its CNAME chain (at most eight links) into addresses with the smallest TTL, or `NXDOMAIN`, no data, or failed (`SERVFAIL`, truncated, undecodable) | Durable: pure |
| `name-cache.ts` | What the relay remembers: keyed by name, family, provider and proxy entry, an hour at most, a minute for a name not found, one query in flight per key, 2,000 entries, never a failure | Durable: pure |
| `proxied-lookup.ts` | The lookup: a routed or onion name refused, an IP literal as it is, this computer's own mappings (`localOnly`), then a DNS-over-HTTPS query from an in-memory session set to the one proxy entry that will carry the connection, with no bypass and no direct fallback; one session per entry (`orivon-name-lookup-<n>`, four at most); every refusal one fixed word | Tied to Electron: it makes requests in sessions it is handed (`fetch`, `resolveHost`, `setProxy`) |
| `relay-link.ts` | What the route controller takes of the relay: the config sessions that follow the system are set to while it is active, and the credentials its listener's proxy challenge is answered with. Types only | Durable: no `electron` import |
| `name-relay-test-seam.ts` | In a test build only, the DNS-over-HTTPS address a suite names in place of the provider's | Durable: gated on the flag that compiles the developer grant |

**What it depends on.** [`../own-proxy.ts`](../own-proxy.ts) (a lookup session sets its own proxy, so the shared identity
leaves it alone), [`../../privacy/secure-dns.ts`](../../privacy/secure-dns.ts) (the value that names the provider, as a type),
[`../../../protocols/builtin.ts`](../../../protocols/builtin.ts) and [`../../../broker/route/onion.ts`](../../../broker/route/onion.ts)
(which names are never looked up), and `@dnsquery/dns-packet` (the message). `electron` for types only: the sessions are handed in.

**What it must never import.** An `electron` value, [`../route-controller.ts`](../route-controller.ts) or anything under
[`../../shell/`](../../shell/). Nothing here asks Chromium's resolver, this computer's DNS or the proxy by name for a site, and
nothing logs or reports a name, an address, a URL or a proxy entry: counts and the words of `LookupWord` only.

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
