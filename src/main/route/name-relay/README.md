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
| `relay-opener.ts` | `front.ts`'s `open`: reads the host from the target's URL (the name Chromium dials and the one the system is asked about, not the text on the request line), refuses a routed or onion name first, asks the system's answer, looks the name up through the proxy it will leave by (IPv4 and IPv6 together, connecting on the first answer), goes through the proxies in order, and bounds the connections it carries | Free of Electron, over the system's answer and the lookups it is handed |

**What it depends on.** [`../front.ts`](../front.ts) (`FrontTarget`, `FrontRefusal`), [`../../../broker/route/socks5.ts`](../../../broker/route/socks5.ts) (the SOCKS5
provider), [`../../../broker/route/onion.ts`](../../../broker/route/onion.ts), [`../../../protocols/builtin.ts`](../../../protocols/builtin.ts) (which suffixes the verifier
serves), `node:net`, `node:tls` and the `socks` package.

**What it must never import.** An Electron value (a type is fine). The system's answer and every lookup are handed in, so a unit test drives the opener
against fakes and real loopback upstreams. Nothing here looks a name up on its own: a name reaches a lookup the opener was handed, or, for a first
`DIRECT` answer, the direct lookup it was handed.

**Owner stream.** `broker`.
