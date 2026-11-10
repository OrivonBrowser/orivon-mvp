# ADR-0111: Behind the system's proxy, a switch that is off by default has Orivon look each site name up through that proxy and ask it for the address

- **Status:** accepted. Built in steps (see Consequences): the first changes no behaviour.
- **Date:** 2026-11-10
- **Type:** architecture
- **Decided by:** owner for the switch, its limits (a Settings switch, off by default; nothing of Orivon's running outside the browser; no sign-in of Orivon's own; no lookup outside the proxy) and the two protections below; AI recommendation for the mechanism

## Decision

Orivon adds a Settings switch, `privacy.resolveBehindProxy`, off by default. While it is on and the system's proxy may apply, every
session that would follow the system is set, through the route controller's `systemConfig` and `systemChanged`, to a name relay of
Orivon's own on `127.0.0.1`: a `front.ts` listener with a secret of its own. No server or remote service of Orivon's takes part, and
none is needed for the switch to work: the relay runs inside the browser, and the lookups go to the DNS-over-HTTPS provider the Secure
DNS setting names, or to Quad9 when it names none (Off and Automatic included).

For each connection the relay asks the session that only follows the system (`orivon-system-proxy`) which proxy the system names for
the URL, looks the name up with an RFC 8484 DNS-over-HTTPS query sent through that same proxy, from an in-memory session of its own set
to that one proxy, and connects through the proxy to the address: HTTP `CONNECT` to the address, SOCKS5 and SOCKS4 by address. A name
is first checked against Orivon's resolver rules and the hosts file, which never reach the network. No lookup for a relayed name is
made by Chromium's resolver, by this computer's DNS or by the proxy. While the relay is active Chromium's own resolver is held at this
computer's DNS and Orivon's own Quad9 check pauses, and the pages of relayed sessions are confined to the proxy (both below). Plain
`http:` becomes a tunnel to the address with the request and its `Host` inside. The relayed sessions keep the names the verifier serves, in both spellings, and the system's copied exceptions
in their bypass list; hosts the system sends outside the proxy are looked up and reached as before.

A name the DNS server does not know, a DNS server the proxy does not let through, a proxy that asks for a sign-in, a SOCKS proxy on
Tor's usual ports, an address that means the proxy's own machine, or a direct entry after a proxy in a proxy script's list fails the
load, with words that name the switch; nothing falls back to the proxy's lookup or to a direct one. A session on a tunnel's front, a
temporary routed tab, a held session and the system-proxy session are never relayed. While the switch is off Orivon behaves as before:
the proxy looks ordinary names up, and the names Orivon serves never reach it. The same relay offers a pinned endpoint, for a caller
that checks addresses: the relay looks the name up, and the endpoint connects only to the address the caller pinned for a host and
port.

**Two protections beyond the lookups themselves.** Each keeps this computer's address from a party the switch's promise covers.

- *Chromium's own resolver is held at this computer's DNS while the relay is active.* With any Secure DNS choice but Off, Chromium
  sends availability probes straight to the DNS provider about five seconds after its resolver is configured, and Orivon's own Quad9
  check asks Quad9 directly every five minutes. None carries a site's name; each shows the provider this computer's address. So
  while the relay is active Chromium's resolver uses this computer's DNS and the Quad9 check pauses, and the Secure DNS setting
  applies again when the relay stops. Cost: Secure DNS stops covering the hosts the system sends outside the proxy, the proxy's own
  name and a proxy script's lookups while a proxy applies.
- *WebRTC in relayed pages is confined to the proxy.* Behind any system proxy today UDP leaves directly and shows this computer's
  address to STUN servers and peers. While the relay is active the pages of relayed sessions are held to the proxy as a routed
  app's pages are, so calls connect only through a TURN server reachable over TCP, and the switch's words say so.

## Context

Names Orivon serves are looked up inside the browser, never by the operating system or a proxy (ADR-0107). Behind a system proxy,
ordinary names are still looked up by the proxy: Chromium sends `CONNECT name:443` with `Host: name:443`, and an absolute-form
request for plain `http:`. Both behaviours are wanted, with this one opt-in, and with it on a person who expects their own address
hidden must never have it shown, by a lookup included.

Measured on Linux (Electron 44.7.0, Chromium 152): `https:` and `wss:` reach an HTTP proxy on loopback as `CONNECT host:443`, `ws:` as
`CONNECT host:80`, `http:` in absolute form; Chromium keeps one tunnel per connection and a plain-http proxy connection per destination
host; a 502 to `CONNECT` fails the load with `ERR_TUNNEL_CONNECTION_FAILED`, unretried, its body unseen, and a 502 to an absolute-form
request is shown as the page; Chromium retries a 407 on the same connection, holds two realms for one proxy, and keys every credential
to the proxy's address as it sees it; the address a proxied request reports is the proxy's. `resolveHost` sends its DNS-over-HTTPS
query straight to the DoH server whatever the session's proxy, so it cannot carry the lookup. `ses.fetch` from a session on a fixed
proxy sends `CONNECT dns.quad9.net:443`, after which Chromium looks nothing up and connects nowhere but the proxy, over one HTTP/2
connection; through SOCKS4 Chromium looks the DoH server's name up itself, so through SOCKS4 the query goes to the server's address,
which its certificate lists. Quad9 refuses the JSON form at port 443 and a query with two questions. Through an exit in another country
the query reached the provider's node near the exit, and no client subnet was passed on. A session on a fixed proxy that cannot be
reached fails every request and sends none direct. A utility process forked with a session uses that session's proxy, and with
`respondToAuthRequestsFromMainProcess` its 407 reaches main.

## Alternatives considered

- **Look names up directly from this computer, with the Secure DNS choice.** The DNS provider, or with Secure DNS off the local
  network's DNS, would see the person's address with every name.
- **Fall back to the proxy's lookup, or to this computer's DNS, for a name Orivon cannot find.** A network that blocks the DoH server,
  or answers "no such name", would hand every name back, which is what the person turned the switch on to stop.
- **A second DoH provider when the chosen one cannot be reached.** It sends the person's names to a provider they did not choose.
- **Refuse the switch while Secure DNS is Off.** It fails every load for a setting that chooses the resolver for direct traffic; Quad9
  through the proxy fails only where the network blocks it.
- **Send the query from the system-proxy session.** It follows the system, so a proxy script's direct fallback, or a direct answer for
  the DoH server's own address, would send the query outside the proxy.
- **Reuse the JSON DoH client, or a resolver library that puts both questions in one query.** Quad9 refuses both.
- **A DoH client of the relay's own over Node's TLS and HTTP/2.** A second TLS stack without the system's trust store, where a
  session's `fetch` brings Chromium's TLS, pooling and every proxy protocol.
- **The relay on all the time while the switch is on.** No window after a proxy is turned on, but every connection through the main
  process and no HTTP/3 or Encrypted Client Hello even with no proxy.
- **Rewrite plain-http requests to an address in absolute form.** A proxy that follows RFC 9112 replaces `Host` with the address, and
  the server serves the wrong site.
- **No secret, so the proxy's sign-in passes untouched.** Any program on this computer could use the relay to reach the proxy, one a
  per-application firewall holds back included.
- **Copy the system's rules into the relay.** A second matcher of Chromium's rule grammar, wrong for scripts and detection; the
  system-proxy session answers the same question per connection, as Chromium itself would.

## Reasoning

The relay is the smallest addition to what exists. `front.ts` already listens on loopback behind a secret, answers only `CONNECT` and
absolute form, strips the hop's credentials and turns plain requests into origin form on a fresh carrier; the controller's seam
already sets every session that follows the system, in its turn, and skips the tunnelled ones; the system-proxy session already
gives Chromium's own answer. The relay adds the lookup and the upstream clients. Sending the lookup through the very proxy entry that
carries the connection, from a session with no direct fallback, keeps the person's address behind the proxy for the lookup as for the
connection, and makes the answer fit where the connection leaves. A session's `fetch` gives the query Chromium's TLS and connection
pool; the wire format is a mature pure-JavaScript library already in the dependency tree. Failing closed keeps the switch's promise
independent of whether the network lets a lookup through.

## Consequences

- The proxy no longer looks names up, but it still sees each site's name in the TLS handshake, and one connection to the DNS provider;
  a company filter that reads only the `CONNECT` line sees addresses, and many refuse bare addresses.
- The DNS provider sees every name, from the proxy's address. A network or proxy that blocks it makes every relayed site fail, with
  words that say so. Each new name costs about one round trip through the proxy to the DNS provider before its connection.
- A proxy that asks for a sign-in does not work: the credentials Chromium holds for a proxy are offered to the relay, keyed to its
  loopback address. A later step can pass Basic and, probably, NTLM through after the relay's secret, never Digest or Kerberos, whose
  answers bind the name or the proxy's service name.
- Names only the proxy can find, such as a company's internal sites, open only when the system's proxy exceptions or the hosts file
  name them.
- Hosts the system sends outside the proxy, the proxy's own name and a proxy script's own lookups stay on this computer, with this
  computer's DNS while the relay is active; Secure DNS does not cover them then.
- Plain `http:` through a proxy that allows tunnels only to port 443 stops opening; a proxy script's fallback to direct when its
  proxy is down no longer applies; WebRTC in relayed pages works only through a TURN server the proxy can reach.
- For about two seconds after a proxy is turned on (the mirror's question interval), the sessions still let it look names up.
- Every relayed connection passes through the main process; it moves to a utility process if the measured event-loop delay passes
  its bound.
- New egress: the relay's DNS-over-HTTPS queries through the proxy, its connections to the proxy by address, and to an address
  directly for a first direct answer. A row in `egress.md`, a threat row, and changes to T12, T20, T84 and T90. A new direct dependency,
  `@dnsquery/dns-packet`, pure JavaScript.
- `orivon://report` states the switch, the relay's state, its DNS provider, whether Chromium's resolver is held, and the refusal
  counts, in fixed words with no name or address.
- Built in steps: the seam (no behaviour change: `front.ts` can reach a target through a function it is given and refuse with a
  reason, the controller composes the relay's config and credentials with the mirror's, the mirror tells a listener each pass, and
  the fetch of Orivon's own requests answers the relay's challenge), the lookup through the proxy (not wired), the relay core (not
  wired), the switch, the pinned endpoint with the callers that check addresses, and, later and only if wanted, proxy sign-in.

## Reversibility

- **Cost to reverse:** cheap. The switch is off by default; making `systemConfig()` ignore the relay and releasing the resolver hold
  restores today's behaviour, and nothing persistent depends on it beyond the setting's key.
- **What would make us revisit:** Electron sending Chromium's own DNS-over-HTTPS through a session's proxy, or resolving names locally
  before an HTTP proxy; the CPU and event-loop measurement of the relay in main failing its bound; reports of company proxies refusing
  bare addresses or the DNS providers from people who turned it on; DNS providers refusing queries through common proxies.
