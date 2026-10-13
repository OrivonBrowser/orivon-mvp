# ADR-0080: An installed app can send everything it does through one proxy, and what the proxy cannot carry is refused

- **Status:** accepted. *Provisional* on the verifier host: update checks and name resolution run there with no session of its own, so they are paused for a routed app until it takes a route per request.
- **Date:** 2026-10-13
- **Type:** architecture / security
- **Decided by:** owner (the feature: `d-0609`); AI recommendation accepted by default for the shape

## Decision

A person sets one SOCKS5 proxy for the browser (Tor on `127.0.0.1:9050`, or any other) and turns it on for an
installed app, one app at a time. From then on everything that app causes to leave the computer goes through
that proxy: `orivon.net` calls, the pages it shows in a `<webview>`, the third-party `https` its page loads, the
lookups the browser makes about it, and its child processes' sockets. What the proxy cannot carry is refused,
never sent direct, and when the proxy stops answering the app's traffic stops with it. A name is sent to the proxy
unresolved. Websites are not routed.

The part that decides is a *route* (`src/broker/route/`): a provider that opens a TCP stream to `host:port` and
may also send UDP and resolve names. The SOCKS5 provider is the first. The broker reads the route of the caller on
every `orivon.net` call; main supplies it from the set of routed apps and the proxy setting.

Chromium cannot authenticate to a SOCKS proxy, and Node already has an HTTP server, so each routed app has a
loopback HTTP front (`src/main/route/front.ts`) that turns Chromium's `CONNECT` and absolute-form requests into
route connections and answers only a caller that sends the secret made for it. The app's sessions are pointed at
the front with a rule that never ends in `direct`.

## Context

The roadmap lists "Tor and proxy chains" under Later, and the owner asked for the first step. Only an installed
app has a session of its own (`persist:app-<hash>`), so only it can be pointed at a proxy without touching
anything else. T20 already makes `orivon.net` fail closed behind a system proxy, which is the opposite of this: a
person who chose a proxy for one app wants the app to use it, not to be refused.

## Alternatives considered

- **The system proxy for the whole browser.** Rejected: every site shares the default session and storage, so
  routing one routes all, and the person asked for a choice per app.
- **A SOCKS proxy rule in Chromium, with no front.** Rejected: Chromium cannot send a user name and password to a
  SOCKS proxy, and without one Tor gives every app the same circuits.
- **Routing only the broker's sockets.** Rejected: a `<webview>`, a WebSocket from a worker or WebRTC would leave
  directly, and "everything the app does" would be false.
- **Allowing `direct` as a fallback when the proxy is down.** Rejected: the person chose the proxy so that the app
  is never seen from their address.
- **Resolving names here, then asking the proxy for the address.** Rejected: it tells the local resolver and the
  network which names the app asks for, which is what a proxy is for hiding.

## Reasoning

Every path that carries an app's traffic has one decision point that can take a route: the broker for
`orivon.net`, the loader's reach path for third-party `https`, and the session's proxy for Chromium. The front
makes the third one a route connection too, so the provider interface is the only thing that knows how a stream is
carried and another kind of provider plugs in without a caller changing.

Measured on Electron 44 before building (headless, names only the front knew, a resolver that answered nothing):
`http:`, `ws:`, `wss:` and `https:` in a session reach the front, with the name never resolved here (a WebSocket
tunnels through `CONNECT`); the application's `login` event answers the front's `407` for requests with a web
contents and without one (`session.fetch`, `net.request`); under `disable_non_proxied_udp` an `RTCPeerConnection`
given a STUN server gathers no candidate and sends nothing, where the default policy gathers candidates and sends;
with the front stopped every request fails with `ERR_PROXY_CONNECTION_FAILED` and no connection is made, where the
same request with `direct` reaches its target; and a `WebTransport` to a name a direct connection reaches sends
nothing while a proxy is set. A service worker of a cache-served app cannot reach the proxy at all: its `https`
goes to the session's handler and its `http` is mixed content.

## Consequences

- A routed app's `listen` with scope `network` and its `lookup` are `denied`; a loopback listen is allowed and a
  loopback target goes direct. A page that resolved names with `dns.lookup` has to let the proxy do it.
- WebRTC runs only over TCP relays for a routed app.
- Turning a route on or off, or changing the proxy, closes the app's broker handles and the connections of its
  sessions, so nothing opened before stays on the old path; a switch also reloads its tabs.
- An app's updates are not checked while it is routed, and name resolution by the verifier host is paused for it.
  The switch is offered only for an app whose files are held here, because a first visit has nothing to pause.
- Each app signs in to the proxy with a name and password of its own, made from a hash of its origin and a secret
  made for the run, so Tor's default isolation gives it its own circuits.
- A hostname is resolved by the proxy, so the proxy decides whether a name that points into the local network is
  reached.

## Reversibility

- **Cost to reverse:** moderate. The provider interface and the broker's reading of a route are small; the front and
  the session wiring are tied to Electron.
- **What would make us revisit:** the verifier host taking a route per request, which ends the pause; a provider
  other than SOCKS5; or routing websites, which first needs storage of their own.
