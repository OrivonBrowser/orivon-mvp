# ADR-0017: Orivon owns the app's HTTP path -- it terminates TLS, routes `fetch`, and lets apps set their own headers

- **Status:** accepted
- **Date:** 2026-09-09
- **Type:** architecture
- **Decided by:** owner

## Decision

Three parts of one decision, because they only work together:

1. **Orivon terminates TLS on the app's behalf.** A secure-connection capability, with the
   handshake, certificate validation and hostname verification performed by the trusted side using
   the encryption stack already built into the shipped runtime. No new dependency, so Rule 8 is
   unaffected.
2. **The page's own `fetch()` is routed through the capability** for hosts the app has been granted.
3. **An app may set any request header on a granted host**, including headers a page is normally
   forbidden to set -- `Origin`, `Referer`, `User-Agent`, `Cookie`.

Network permission stays **declared in the manifest and granted once at install**. There is no
just-in-time prompt for a new host: a host outside the declaration is denied, as today. A manifest
may declare unlimited HTTPS, and **the prompt must make breadth visible** -- a narrow declaration
must not look like an unlimited one.

## Context

`orivon.net` offers raw TCP only, and nothing in `src/contracts/` mentions TLS. Meanwhile the
renderer's own `fetch` is CORS-bound, which is the wall [ADR-0001](./ADR-0001-flagship-app-bittorrent-streaming.md) reason 3 exists to beat.

The FreeTube reconnaissance ([`freetube-port-recon.md`](../planning/freetube-port-recon.md)) turned this from a design
preference into a requirement, and corrected an assumption in the process:

- Its renderer imports **zero** Node builtins and **zero** Electron APIs. All 32 of its network
  calls are the browser's own `fetch`. The Node compatibility layer does nothing for it.
- Those calls only work because its **main process rewrites the outgoing headers** -- setting
  `Origin: https://www.youtube.com` for some hosts and deleting `Origin` for others. Those are
  headers a page cannot set, which is precisely why that code lives in main.
- It also contacts whatever alternative server the **user** types into its settings, which no
  manifest can predict.

So: routing `fetch` is the difference between working and not working; routing without app-chosen
headers still fails, because the far end rejects the requests; and prompting per new host fails
because **an app that does not know Orivon exists cannot wait for a decision** -- it fires parallel
requests with its own timeouts and retries.

## Alternatives considered

**A TLS stack in JavaScript over raw TCP.** No new capability needed. Rejected: the mature
pure-JavaScript options are dated and unaudited for this use, and a subtly wrong certificate check
is indistinguishable from a correct one until it is exploited -- in our code, in the
security-critical path, for every app.

**Leave `https` out of v0.** Apps use the browser's `fetch` where the far end permits it. Rejected:
it blocks torrent trackers, web seeds and nearly every ordinary API call, which means it blocks the
flagship.

**Route `fetch` but keep the browser's forbidden-header rules.** Rejected: it leaves FreeTube-class
apps broken even with CORS solved, which is the whole point of routing.

**Ask just in time for each new host.** Precise and honest, and rejected for the reason above --
plus it would ask several times before the first video plays, which teaches people to click yes
without reading.

## Reasoning

The security-critical part is delegated to code that is maintained by someone else and already
ships. That is Rule 6 applied where it matters most.

Because the trusted side terminates the connection, **it knows the true hostname**, so a grant and
a prompt can name it truthfully. A JavaScript TLS stack inside the app would leave Orivon unable to
say what the app is talking to.

Header freedom is safe *because of a property this design already has*: these connections carry no
cookies and no ambient credentials. Nothing can ride the user's existing logins -- the app must
supply everything itself, which makes it closer to a command-line tool than to a browser tab.

And the breadth is not new. Any desktop application on the machine can already reach any host.
Orivon's version is **declared and revocable**, which is strictly better than the status quo it
replaces.

## Consequences

- **`fetch` behaves differently inside Orivon than in Chrome.** This must be documented plainly for
  developers; a silent divergence in a web platform API is a trap.
- **Unlimited HTTPS is the widest permission in the system.** If the prompt renders it the same way
  as a narrow declaration, every manifest will declare unlimited and the prompt stops meaning
  anything. Making breadth visible is therefore load-bearing, not polish.
- An app holding unlimited HTTPS plus a folder the user picked can send that folder's contents
  anywhere. This is the exposure the behaviour-based trust indicator ([ADR-0006](./ADR-0006-trust-indicator-from-observed-behaviour.md)) exists to catch,
  and it should be named in the prompt's design work.
- `src/contracts/` changes, so it merges as its own PR before any implementation.
- Tier-1 web apps and tier-2 Electron apps stop being blocked by CORS at all, which is the widest
  compatibility gain available in the current plan.

## Reversibility

**Medium.** The capability could be narrowed later, but withdrawing `fetch` routing would break
every app that came to depend on it, and withdrawing header freedom would break them
individually and silently. The parts to revisit deliberately are the *breadth* a manifest may
declare and how the prompt presents it -- not whether the path exists.
