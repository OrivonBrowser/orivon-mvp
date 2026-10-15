# ADR-0088: Every wait on the load path comes from the route it travels

- **Status:** accepted. *Provisional* on the figures of the tunnel's profile (below), which are measured against Nym and are to be re-measured when another tunnel is offered.
- **Date:** 2026-10-15
- **Type:** architecture
- **Decided by:** AI recommendation, from the owner's reports that with Nym a page finishes loading without its stylesheet and the Web3 Score gives up; accepted by default for the shape

## Decision

**A wait is written once, for a direct connection, and the route a request travels stretches it.** The seam is
`src/protocols/route-pace.ts` (durable). A route declares three numbers, a `RouteProfile`:

- `roundTripMs`: how long a fresh request takes to its first byte once the route is up;
- `coldStartMs`: how long the route may need to come up the first time it is used;
- `bytesPerSecond`: what one transfer carries.

The wait of any step is `directMs x scale`, where `scale` is the route's round trip over the 500 ms a direct wait assumes (never
under 1), plus the cold start while the route has carried nothing. A route added later declares its profile and every wait on
the load path follows; no step has a constant of its own for it. The direct route is `DIRECT_ROUTE`: nothing is stretched.

**The route learns.** A `RouteMeter` keeps the slowest first byte seen on its route in the last ten minutes and waits at
least two and a half times that, up to three times its declared floor, falling back as the evidence ages. A meter never
waits less than its floor because requests came back quickly. The host keeps one meter per route (the one every
website's requests use, and the tunnel profile's); main keeps one for the tunnel (`src/main/route/main-pace.ts`).

**Who takes it.** The mount of a name and the light client's first sync (`verifier-host/pace.ts`), the first-byte wait of a
block, a record and a chunk and the hedge to a second source (`GatewayPool.route`), the patient retry of a node (`retryOn`),
the DNS-over-HTTPS lookup of a DNSLink, and the Web3 Score lookup.

**A transfer fails when it stops, not when a clock runs out.** `askGateway` and the name-service read use a `StallClock`: a
first-byte window (the route's), then a window with no byte (`stallMs`, 10 s on a direct connection, stretched by the route),
and an outer cap sized from the route's rate and the largest the body may be, so a source that trickles for ever still ends.
A body that keeps arriving is never cut by the wait a direct connection would have given it.

**A file of a page that failed for want of an answer is read again before the page is told it is missing.** On the serve path
(`verifier-host/serve/retry.ts`; not the page's own document, whose error page offers Try again) a read that fails `unavailable` is made again twice, after a short pause, from the
blocks already held, unless the reads so far already took the route's patience (30 s on a direct connection, stretched); a missing path, a failed check and an unsupported format are not read again (they would fail the same way).

**A page that is not whole says so.** The shell notes every file (not a document or a frame) the verifier answered with a 5xx,
per tab, forgets it when the same file later arrives or the tab loads another document, and shows a mark in the address bar
("Some files of this page did not load...") that reloads the page.

**The Web3 Score lookup is patient on a slow route.** A fetch that failed for want of an answer is asked again (up to four
asks) while the route's patience lasts, the failure is not kept for a minute when the route is slow, the unreachable verdict
carries when asking again is worth it (later on a slow route), and the shield asks again up to eight times.

## Context

With the whole browser on Nym the nodes and the verifier host reach the network through one mixnet connection of about
15 to 40 KB a second with round trips of about a second. Measured with the real module, the IPNS record of
`thelounge.orivonstack.eth` was not read by the node within the 15 s a direct connection gets and the page failed at 40 to 65
s; the node answers a block it has not yet found with a 404 after 5 to 10 s and asks again only after the 32 s its own
memory needs, so a page's files arrive one to three minutes apart; a request whose clock ran out answered an error page, which
for a stylesheet is a page with text and no colours that Chromium counts as loaded, and the loading indicator stops. The
Web3 Score lookup of a provider the verifier serves waits on the same name proof, and its failure was kept for a minute.

## Alternatives considered

- **Raise each constant.** Rejected: it fixes Nym and nothing after it, and the figure is wrong again for the next route.
- **One long timeout everywhere.** Rejected: a direct connection that is down would make the person wait minutes for an error.
- **Retry in the page (a script that reloads failed stylesheets).** Rejected: the shell does not run code in a site's page, and
  an app's own request is not ours to repeat.
- **Hold the document until every file is read.** Rejected: a page may ask for a file only when it runs, and a 14 MB site would show nothing for minutes.

## Consequences

- A hopeless lookup on a slow route fails later than on a direct one (a mount of a name is given 150 s and 95 s more while
  the tunnel is cold, instead of 25 s). The loading screen is what the person sees meanwhile.
- The cap of a transfer bounds a source that sends one byte a second (T87).
- The node's own route is the host's route today (the whole browser on the tunnel). A node that leaves by a different route
  than the host's requests supplies its own pace.

## Reversibility

Reversing it is a change of `route-pace.ts` and the one line each step reads it in; the profiles are data.
