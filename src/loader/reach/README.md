# `src/loader/reach/`: the third-party reach path

**What lives here.** `reach.ts` (`nodeReachDial`, the real Node `https` dial), `cors.ts`
(answering a CORS preflight without the network), `guard.ts` (re-checking for revocation and
releasing the slot), `redirects.ts` (the redirect cap) and `slots.ts` (the per-origin reach
allowance queue).

**What it depends on.** [`../../contracts/`](../../contracts/). `reach.ts` stays free of broker
policy and Electron entirely on purpose (see Design notes); `guard.ts` type-imports
[`../serve/serve.ts`](../serve/serve.ts)'s `ReachDial`.

**What it must never import.** [`../../shim/`](../../shim/) -- see the parent README's "What it
must never import".

**Owner stream.** `loader`, build step 4.

## Design notes

**Why a cross-origin request inside an app's own partition reaches `fetchThirdParty`, not an
automatic denial (A143).** `session.fromPartition(...).protocol.handle('https',
...)` intercepts the WHOLE scheme for that session, not merely requests to the app's own host, so
a page in its own partition fetching a third-party `https://` URL (a CDN font, an `<img>` pointing
elsewhere) reaches this same handler, and an app may reach a host it holds a granted
`https.connect` for. [`../serve/serve.ts`](../serve/serve.ts)'s `fetchThirdParty` authorises
against the LIVE grant via `checkConnectSecure`, the SAME function `orivon.net.connectSecure`
itself calls, and, if allowed, performs the real fetch through [`reach.ts`](reach.ts)'s
`nodeReachDial` (Node's own `https` module, chosen over Electron's `net.fetch` specifically so
this path could be proven end to end over a real TLS handshake in a real Electron launch; see
that file's own header). An ungranted host and a plain `http:` request (A163, a deliberate,
narrower scope decision, not a gap) get the same fail-closed `denyResponse` as every other
refusal. `connect-src`, `img-src`, `font-src` and `media-src` widen alongside it, from the same
`https.connect` grant (`connect-src.ts`'s `reachSourcesFor`): without that, the header would
refuse the very requests this decision exists to allow before they could reach the handler. "The
third-party reach path", below, covers what a granted request meets on its way through.

**Why [`reach.ts`](reach.ts) uses Node's own `https` module, not Electron's `net.fetch`
or a hand-rolled HTTP/1.1 client.** `test/e2e-fetch-routing.test.ts`'s own header records why an
unmodified Electron build cannot be made to trust a locally generated test certificate, which is
why that file proves its own byte round trip over plain HTTP rather than HTTPS. Node's own `https`
module takes a per-request `ca` override (`../../broker/adapters/tls-adapter.ts`'s own established
seam, same shape, same "testing only" rule), so this mechanism can be proven end to end over a
real TLS handshake in a real Electron launch (`tests/reach.test.ts`), a real advantage Electron's
own `net.fetch` does not have. A hand-rolled client (the shape `src/preload/routed/fetch.ts` is
forced into by its own `contextBridge` serialisation constraint) was rejected because nothing here
needs that constraint: Rule 6 says prefer the mature, already-audited component once a hand-rolled
one is not actually required, and Node's own client already handles chunked encoding and keep-alive
correctly. Two further properties this choice buys for free: `https.request` has no concept of a
session or a cookie jar at all, so there is nothing to remember to set (contrast Chromium's
`fetch()`, which needs an explicit `credentials: 'omit'` for the identical guarantee); and it never
follows a redirect itself: a 3xx goes back to the page's loader, which follows it through this same
handler, so a granted host can never hand a request off to one nobody approved.

**Why A199's cancellation hooks in the handler, not the dial or the grant ledger's own cascade**
(`docs/open-questions.md` A199/A200). `fetchThirdParty` (`../serve/serve.ts`) authorised a
third-party reach only ONCE, before dialling -- a person who revoked the grant, watched the row
disappear from the permissions UI, and then kept receiving bytes from that host had been shown
something untrue. Three places could have hooked the fix in:

- **The handler (`../serve/serve.ts`, chosen).** [`guard.ts`](guard.ts)'s
  `guardReachResponse` wraps the streamed `Response` body and re-calls the SAME `authoriseReach`
  the handler already calls once, on a short timer, for as long as the body is still being read.
  A revoke it catches cancels the underlying reader and errors the wrapped stream -- what a
  page's own `fetch()` then observes is a rejected read, never a byte count it could mistake for
  a complete file. This keeps the one thing that already knows about grants (the handler, the
  only caller of `authoriseReach`) the only thing that still has to.
- **The dial (`reach.ts`, rejected).** That file's own header commits to staying free of
  broker policy and Electron entirely -- it is the one place in this directory doing real network
  I/O, kept small and auditable on purpose. Teaching it "is this still authorised" would mean
  either importing broker policy into it (duplicating a decision the handler already makes) or
  threading a live callback into it from the handler anyway, at which point the polling loop is
  still handler-driven, just relocated into a file with no other reason to know about grants.
- **The grant ledger's own cascade (`HandleTable.revoke`, rejected).** The most architecturally
  "pure" option -- zero-latency, push-based, the exact mechanism `net.connect`/`net.connectSecure`
  already get from `HandleTable.run`'s grant-scoped operation bucket. Reaching it for a reach
  request means either registering a proxied HTTP response as a `HandleTable` resource it was
  never shaped for (no app-visible `Handle`, and a lifetime measured in a streamed download rather
  than a quick dial -- a real risk of starving that origin's OTHER operations against
  `LIMITS.inFlightOperations` for as long as one large download is in flight), or adding a
  bespoke revoke-notification path to the broker's core revocation cascade -- a change to files
  the `broker` stream owns and was actively working in at the time this landed. A bounded poll
  costs latency (`REACH_REVOCATION_POLL_MS`, currently 200ms) for a benefit (true push) that does
  not change what the reading page observes qualitatively: it still sees a real failure, just up
  to one poll interval later.

**Why A200's allowance reuses `GrantLedger.socketAllowance` through a new `Broker.app
.socketAllowanceSync`, rather than re-deriving the clamp in the loader.** An app's simultaneous-
socket allowance is declared in its manifest, clamped to `LIMITS.concurrentSockets`, and enforced
for `net.connect`/`net.connectSecure`/`net.listen` via `HandleTable.acquire`'s `socketLimit` --
but `fetchThirdParty`'s reach path never consulted it, so an app could hold unlimited concurrent
third-party requests regardless of the number it declared and the person approved. The clamp
itself (`resource-limits.ts`'s `socketAllowance`) is two lines of arithmetic, cheap enough to be
tempting to copy -- but code-guidelines.md Rule 3 is explicit that the
NUMBER must be reused, not re-derived, so a future change to the clamp (or to what counts as
"declared") cannot silently drift between the two enforcement points. `Broker.app
.socketAllowanceSync` is a one-line, synchronous, never-throwing delegate to
`GrantLedger.socketAllowance` -- the same category as `hasGrantsSync`/`isRegisteredSync`, and the
same kind of loader-specific seam `hydrateFromPinnedManifest` already is (A158). The actual
IN-FLIGHT COUNT is new state, by necessity: a proxied reach request is never a `HandleTable`
resource (no app-visible `Handle`, no revocation cascade of its own), so `../electron/serve.ts`'s
`reachSlotsFor` keeps one [`slots.ts`](slots.ts) pool per origin: a free
slot is checked-and-reserved as one synchronous step against that same number (the identical
discipline `GrantLedger.reserveFsBytes`'s own doc names for why a quota check and its reservation
must never straddle an `await`), and a request that finds none waits in the pool's queue.

**Why a reach request over the allowance waits in a queue, when T11b says limits reject rather than
queue.** T11b's rule (`handle-contracts.md`'s Limits section) is about the broker's own operations: an
unbounded queue of broker work on the UI thread is how one origin freezes every tab. A queued
reach request is none of that. It is a pending promise and a timer, per origin, bounded in length
(`REACH_SLOT_MAX_WAITERS`, 256) and in time (`REACH_SLOT_WAIT_MS`, 30 s); past either it is refused
exactly as before. Refusing at once, on the other hand, broke real pages: a browser queues an
over-limit request, and a page has no retry for an image or a script that answered 404. The queue
is FIFO, a newcomer never takes a slot ahead of it, and a request that waited is re-authorised
before it dials, so a grant revoked meanwhile is not used. Both numbers are provisional.

**The third-party reach path, in order** (`../serve/serve.ts`'s `fetchThirdParty`). Every step is
measured or unit-tested; the two platform facts it rests on come from
`test/e2e-served-csp.test.ts`.

1. **Redirect cap.** A 3xx this handler returns is followed by the page's own loader, back through
   this same handler, so each hop is authorised afresh, `redirect: 'manual'` yields an opaque
   redirect, `connect-src` is re-checked against the target, and `Authorization` is dropped on a
   cross-origin hop. That loader applies no redirect cap at all to a `protocol.handle` response
   (60 hops measured), so [`redirects.ts`](redirects.ts) counts hops per
   chain and answers the 21st with a network error, the Fetch standard's own limit. A chain is
   keyed by URL; one whose target URL is re-serialised differently restarts its count.
2. **Authorisation** against the live `https.connect` grant.
3. **A CORS preflight** to a granted host is answered without the network
   ([`cors.ts`](cors.ts)). Only a browser preflight carries
   `Access-Control-Request-Method`, so an app's own `OPTIONS` request still reaches the host.
4. **A socket-allowance slot**, waited for in the bounded queue above, and re-authorisation after
   any wait.
5. **The dial** ([`reach.ts`](reach.ts)), with an idle timeout
   (`REACH_IDLE_TIMEOUT_MS`, five minutes) that every byte resets, so a long-poll or an event
   stream lives as long as it keeps talking.
6. **A redirect goes back bodiless**, which frees its slot and upstream socket at once rather than
   whenever the loader gets round to the body.
7. **Anything else streams** through the revoke guard (A199), with CORS response headers for the
   app origin. Electron 44 does not enforce CORS on a `protocol.handle` response at all (measured:
   a cross-origin response with no `Access-Control-Allow-Origin` was readable, and a `PUT` sent no
   preflight), so today the headers only keep worker fetch and XHR working if it ever starts to.
