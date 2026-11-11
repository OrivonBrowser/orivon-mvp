# `src/main/route/name-relay/`: looking up a site's address in Orivon, behind a system proxy

**What lives here.** The pieces of the name relay: the setting, off by default, that makes Orivon look up every site's
address itself while the system names a proxy, sending each lookup through that proxy and never from this computer, and
connect through the proxy to the address, so the proxy is asked for an address and never for a name. A connection Chromium
asks a loopback listener ([`../front.ts`](../front.ts), given an `open`) to make reaches `relay-opener.ts`, which asks the system
which proxy applies, has the name looked up through it and connects. `relay-switch.ts` runs it while the switch is on and a
proxy applies (`route-subsystem.ts` wires it), and the callers in main that check an address use its lookup while it runs.

| File | Job | Durable or tied to Electron |
|---|---|---|
| `addresses.ts` | Which addresses a proxy is asked to connect to: IPv4 before IPv6, at most three, never one that means the proxy's own machine (loopback, unspecified, link-local); when the next address is worth a try | Durable: pure |
| `doh-message.ts` | The RFC 8484 message: one question per query, ID 0, an OPT record padded to a 128-byte block, no client subnet; an answer read along its CNAME chain (at most eight links) into addresses with the smallest TTL, or `NXDOMAIN`, no data, or failed (`SERVFAIL`, truncated, undecodable) | Durable: pure |
| `name-cache.ts` | What the relay remembers: keyed by name, family, provider and proxy entry, an hour at most, a minute for a name not found, one query in flight per key, 2,000 entries, never a failure | Durable: pure |
| `pinned-endpoint.ts` | A listener for a caller that checks before it reads: the caller pins a host and port to the address it cleared and the listener connects to that address and nothing else, as the relay does; it never looks a name up and refuses a host and port nobody pinned (`unpinned`); its challenge is answered by the route controller like a front's, so the broker refuses an app's socket to its port; `relayLookup` is the lookup callers use while the relay runs; `onConnected` reports each connection as the address and the road, never a name | Free of Electron, over the system's answer it is handed |
| `pinned-session.ts` | The in-memory session a caller in main reads through a pinned endpoint: one per endpoint, left alone by the shared identity, set to the endpoint's config before it is handed back | Tied to Electron (a session, as a type) |
| `quiet-session.ts` | Takes the spell checker off a session Orivon makes for its own work with no page in it (a lookup session, the pinned one, the sessions that ask the system's proxy a question or copy its settings, the one that fetches a proxy script), before its first request: Electron would otherwise fetch a dictionary into it from a fixed host, through the proxy by name, through the pinned endpoint as a connection nobody pinned, or from this computer on a direct session |
| `lookup-forget.ts` | How "Clear browsing data" reaches the lookups' cache: whoever runs the lookups registers the way to forget every answer, and the privacy domain calls it | Durable: pure | Tied to Electron (a session, as a type) |
| `proxied-lookup.ts` | The lookup: a routed or onion name refused, an IP literal as it is, this computer's own mappings (`localOnly`), then a DNS-over-HTTPS query from an in-memory session set to the one proxy entry that will carry the connection, with no bypass and no direct fallback; one session per entry (`orivon-name-lookup-<n>`, four at most); every refusal one fixed word; every answer kept is forgotten when a query meets a network change | Tied to Electron: it makes requests in sessions it is handed (`fetch`, `resolveHost`, `setProxy`) |
| `proxy-answer.ts` | The system's answer to "which proxy for this URL?" read into the proxies in order (`PROXY`, `HTTPS`, `SOCKS`, `SOCKS4`, `SOCKS5`, lists), a first `DIRECT`, or a reason to refuse; a `DIRECT` after a proxy is never among them; the stricter of the answers for two URLs of one connection (a tunnel to a port other than 443 is asked about under both schemes, and is `DIRECT` only when both say so); a SOCKS proxy on this computer at a port Tor listens on | Durable: pure |
| `relay-link.ts` | What the route controller takes of the relay: the config sessions that follow the system are set to while it is active, and the credentials its listener's proxy challenge is answered with. Types only | Durable: no `electron` import |
| `relay-failures.ts` | The fixed words for why a connection was not carried (`RefusalWord`, a superset of `LookupWord`), the `RelayRefusal` the listener answers with, the sentence for each (`unpinned` is a pinned endpoint's, for a host and port nobody pinned), and the reason noted for a host and port for 30 seconds, which the load-error sheet reads | Durable: pure |
| `relay-listener.ts` | The listener assembled: `front.ts` on loopback with a secret of its own, whose `open` is the relay's opener over the system's answer and the lookups it is handed; each refusal is counted, worded and logged as a word; it stops by draining, so a tunnel in flight finishes | Durable: no `electron` import |
| `relay-status.ts` | What the relay is doing as fixed words and counts (`off`, `idle`, `relaying`, `held`, `down`; the provider; whether Chromium's resolver is held; one count per refusal word) for `orivon://report`, the line for a change of state, at most one refusal line a minute for each word, and the reason noted for a host and port, which the load-error sheet reads | Durable: pure |
| `relay-switch.ts` | When the relay runs (the activation table per mirror mode, the system's answer for ordinary addresses, the environment and a private window held to Nym) and what turning it on and off does, in the order that keeps this computer's address from showing: the listener, the resolver hold, the WebRTC confinement of the pages of the sessions that follow the system, the callers that check addresses, the sessions, the pages loaded again. A listener that cannot start, or stops by itself, is started again on a new port, and until then the sessions are pointed at the dead end and the state reads `down` | Durable: Electron-free over the calls it is handed |
| `relay-lookup.ts` | The relay's lookup for a caller that checks an address first: the same steps, through the proxy entry the system names for the URL, as a relayed connection; every address comes back (IPv4 first), so the caller judges all of them; a routed or onion name refused, an IP literal as it is | Free of Electron, over the calls it is handed |
| `relay-opener.ts` | `front.ts`'s `open`: reads the host from the target's URL (the name Chromium dials and the one the system is asked about, not the text on the request line), refuses a routed or onion name first, asks the system's answer, looks the name up through the proxy it will leave by (`proxied-lookup.ts`'s answer: IPv4 first, connecting before IPv6 has answered), goes through the proxies in order, has the lookup forget a name every address of which failed, reports each connection it made (the address and the road), and bounds the connections it carries | Free of Electron, over the system's answer and the lookups it is handed |
| `utility-login.ts` | Answers a utility process's proxy challenge in main: the sign-in an Electron utility process forked with `respondToAuthRequestsFromMainProcess` raises is read by position, as it arrives with four arguments where the typings list three | Tied to Electron (a utility process's event) |
| `name-relay-test-seam.ts` | In a test build only, the DNS-over-HTTPS address a suite names in place of the provider's | Durable: gated on the flag that compiles the developer grant |
| `upstream.ts` | One connection to an address: through an HTTP or HTTPS proxy (`CONNECT <address>:<port>` with `Host: <address>:<port>`), SOCKS5 or SOCKS4 by address, or straight to it; says whether to try the next address, the next proxy or neither | Tied to the operating system's network (`node:net`, `node:tls`, `socks`), not to Electron |

**What it depends on.** [`../own-proxy.ts`](../own-proxy.ts) (a lookup session and a pinned session set their own proxy, so the shared identity
leaves them alone), [`../../privacy/secure-dns.ts`](../../privacy/secure-dns.ts) (the value that names the provider, as a type),
[`../../../protocols/builtin.ts`](../../../protocols/builtin.ts) and [`../../../broker/route/onion.ts`](../../../broker/route/onion.ts)
(which names are never looked up), [`../front.ts`](../front.ts) (`FrontTarget`, `FrontRefusal`), [`../lookup-session.ts`](../lookup-session.ts) (the type of a challenge's answer), [`../system-follow.ts`](../system-follow.ts) (the type of a session's config), [`../proxy-mirror/`](../proxy-mirror/) (the types of a pass and of the mirror's status, which `relay-switch.ts` reads), [`../verifier-name-guard.ts`](../verifier-name-guard.ts) (the names a session keeps off the proxy),
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

**A caller that checks an address pins what it checked.** A check followed by a second lookup is a rebinding: the proxy looks the
name up again and may get another address than the one the caller cleared. So the relay looks the name up once (`relayLookup`),
the caller judges every address it returns, and the pinned endpoint connects to the address the caller pinned, through the proxy
the system names for the URL, as the relay does. The endpoint is a listener of its own with its own secret and never looks a
name up; a host and port with no pin, or an expired one, is refused (`unpinned`) and nothing is sent. A redirect is a new host
and port, so the caller looks it up and pins it before it follows. Callers switch to this path only while the relay runs: with
the relay inactive each keeps the lookup and the road it has.

**A connection is reported as an address and a road.** `onConnected` gives the host asked for, the port, the address connected to
and the road (`PROXY`, `HTTPS`, `SOCKS5`, `SOCKS` or `DIRECT`), so a developer tool and `orivon://report` can say which way a read
left; a log line or a report text holds counts and these fixed words, never a name, an address, a URL or a proxy entry.

**A utility process that signs in to a proxy is answered in main.** A child forked with a session or partition and
`respondToAuthRequestsFromMainProcess: true` raises `login` in main with four arguments at run time (the event, the request, the
proxy's description and the callback) where the typings list three, so the listener reads by position from the second and calls
the callback it finds last.

**The connection upstream carries no header but the one a proxy needs.** Chromium's request and its headers (`User-Agent`, cookies and
the rest) travel inside the tunnel, to the site, which is where they belong; the proxy is sent `CONNECT <address>:<port>` and
`Host: <address>:<port>` and nothing else, so it learns neither the site nor the browser from the request. `FrontTarget` therefore
carries no request headers, and a proxy that wants a `User-Agent` on a `CONNECT` does not get one.
