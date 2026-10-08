# `src/loader/reach/`: the third-party reach path

**What lives here.** `reach.ts` (`nodeReachDial`, the real Node `https` dial), `cors.ts`
(answering a CORS preflight without the network), `guard.ts` (re-checking for revocation and
releasing the slot), `redirects.ts` (the redirect cap) and `slots.ts` (the per-origin reach
allowance queue).

**What it depends on.** [`../../contracts/`](../../contracts/). `reach.ts` stays free of broker
policy and Electron entirely on purpose (see Design notes); `guard.ts` type-imports
[`../serve/serve.ts`](../serve/serve.ts)'s `ReachDial`.

**What it must never import.** [`../../shim/`](../../shim/), as the parent README says.

## Design notes

Why a cross-origin request inside an app's own partition reaches this path at all (A143), and
why plain `http:` stays denied (A163), is `../serve/serve.ts`'s `fetchThirdParty` doc.

**Why [`reach.ts`](reach.ts) uses Node's own `https` module, not Electron's `net.fetch` or a
hand-rolled HTTP/1.1 client.** Node's `https` takes a per-request `ca` (the seam
`../../broker/adapters/tls-adapter.ts` already has), so this path is proven over a real TLS
handshake in a real Electron launch (`tests/reach.test.ts`); an unmodified Electron cannot be
made to trust a locally generated certificate (`test/capabilities/e2e-fetch-routing.test.ts`'s header).
Nothing here forces a hand-rolled client the way `contextBridge` forces
`src/preload/routed/fetch.ts`, so Rule 6 picks the mature one, which already handles chunked
encoding and keep-alive. It has no cookie jar to forget, and never follows a redirect itself: a
3xx goes back to the page's loader, which follows it through this same handler, so a granted
host cannot hand a request to one nobody approved.

**Why A199's cancellation hooks in the handler, not the dial or the grant ledger's own
cascade.** [`guard.ts`](guard.ts) re-calls the handler's own `authoriseReach` every
`REACH_REVOCATION_POLL_MS` while the body is read, and a revoke errors the stream, so the page
sees a rejected read, never a short file. The dial stays broker-free and small. The ledger's
cascade would need a streamed download registered as a `HandleTable` resource, starving the
origin's other operations against `LIMITS.inFlightOperations`. A poll costs at most one interval
of latency. Full account: `docs/open-questions.md` A199.

**Why A200's allowance reuses `GrantLedger.socketAllowance` through `Broker.app
.socketAllowanceSync`, rather than re-deriving the clamp.** One number, one source
(code-guidelines.md Rule 3), or the reach path and `net.connect` drift apart. Only the in-flight
count is new state, since a reach request is never a `HandleTable` resource: one
[`slots.ts`](slots.ts) pool per origin (`../electron/serve.ts`'s `reachSlotsFor`), each slot
checked and reserved in one synchronous step. Full account: `docs/open-questions.md` A200.

**Why a reach request over the allowance waits in a queue, when T11b says limits reject rather
than queue.** T11b (`handle-contracts.md` section Limits) is about unbounded broker work on the UI
thread. A queued reach request is a pending promise and a timer, bounded in length
(`REACH_SLOT_MAX_WAITERS`) and in time (`REACH_SLOT_WAIT_MS`), and refused past either. Refusing
at once broke real pages: a browser queues an over-limit request, and a page has no retry for an
image that answered 404. The queue is FIFO, and a request that waited is re-authorised before it
dials. Both numbers are provisional.

**The third-party reach path, in order** (`../serve/serve.ts`'s `fetchThirdParty`). The platform
facts are measured in `test/app-loading/e2e-served-csp.test.ts`.

1. **Redirect cap** ([`redirects.ts`](redirects.ts)). The page's loader follows a 3xx back
   through this handler, so each hop is authorised afresh, but it applies no cap to a
   `protocol.handle` response (60 hops measured). The 21st hop is a network error, the Fetch
   standard's limit.
2. **Authorisation** against the live `https.connect` grant.
3. **A CORS preflight** to a granted host is answered without the network ([`cors.ts`](cors.ts)).
4. **A socket-allowance slot**, waited for in the queue above, and re-authorisation after any
   wait.
5. **The dial** ([`reach.ts`](reach.ts)), with an idle timeout that every byte resets.
6. **A redirect goes back bodiless**, freeing its slot and upstream socket at once.
7. **Anything else streams** through the revoke guard (A199), with CORS response headers for the
   app origin. Electron 44 does not enforce CORS on a `protocol.handle` response, so the headers
   matter only if it starts to.
