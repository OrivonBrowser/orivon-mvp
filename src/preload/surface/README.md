# `src/preload/surface/`: `window.orivon`'s page surface

**What lives here.** The `orivon.*` exposure every ordinary tab gets: `orivon.ts`
(`exposeOrivon()`, shared by `../app.ts` and `../newtab.ts`'s fallback, so there is one
definition), `control-call.ts` (the `CONTROL_CHANNEL` call and timeout machinery), `net.ts` and
`web.ts` (bridge closures), and `main-world-socket.ts`, the one function serialised into the
main world, with its types in `main-world-bridges.ts`.

**What it depends on.** `electron` (via `require`), [`../../contracts/`](../../contracts/) for
types, [`../../main/channels.ts`](../../main/channels.ts) (the parent README's one exception),
[`../orivon-error.ts`](../orivon-error.ts) and [`../ports/`](../ports/).

**What it must never import.** [`../../broker/`](../../broker/), as the parent README says.
Nothing under [`../routed/`](../routed/): its installers are serialised alone and share nothing
with this folder's.

## Design notes

**Why `orivon.ts` is split three ways.** A new `net.*` method grows `net.ts`, not the file every
other capability lives in. `control-call.ts` is a leaf both import, which is how `net.ts` shares
`call()` without a cycle back through `orivon.ts`.

**Why the streams are built in the main world.** `contextBridge` copies a stream built in the
isolated world as a dead, frozen object, so `main-world-socket.ts`'s `installOrivon` runs in the
page and builds real streams over proxied closures
([ADR-0014](../../../docs/decisions/ADR-0014-main-world-streams-via-experimental-api.md)). It
locks `window.orivon`, the one page global that stays locked
([ADR-0021](../../../docs/decisions/ADR-0021-page-globals-carry-the-platform-descriptor.md)).

**What is wired, and what is left off.** The broker side is
`../../broker/transport/ipc.ts`'s `handleControlRequest`; `fs.readFileSync` alone goes over
`SYNC_CONTROL_CHANNEL`
([ADR-0016](../../../docs/decisions/ADR-0016-synchronous-file-reads-are-permitted.md)). Left
off under the parent README's rule, because the broker does not implement them: `fs.open`'s
`readable()`/`writable()`, and `id.requestIdentity`, which needs the connect-prompt UI.

**`main-world-socket.ts`'s `toOrivonError` builds a real `Error`, unlike `../orivon-error.ts`'s
isolated-world twin.** That file's plain-object choice is load-bearing there because a thrown
plain object still has to cross `contextBridge` (which strips a thrown `Error` down to its
`.message`, A152). Everything `main-world-socket.ts` builds is already past that crossing --
`onReadEnd`/`onFatal`/`close`/`readFileSync` all hand a value straight to the page's own stream
controllers or throw it directly -- so `OrivonError extends Error` (`../../contracts/errors.ts`)
can actually hold, and `callRevived` rebuilds a real `Error` from a bridge rejection (which
crosses as a plain object, `../orivon-error.ts`'s own shape, surviving intact per A152) for the
identical reason: nothing it returns crosses `contextBridge` a second time.

**`buildServer`'s `pull()` firing is the one thing this whole lane exists to preserve.**
`highWaterMark: 0` matches the broker's own `entry.connections` exactly
(`handle-contracts.md`'s "TcpServer" section, `capabilities/net.ts`'s own `listen`): each firing
is exactly one unit of accept demand (`../ports/server.ts`'s `reportAccepted`,
`../../broker/transport/relay/accept-pump.ts`'s `handleDemand` one layer down).
`reportAccepted` must never be called from anywhere else, or the broker accepts connections
nobody asked for (`docs/open-questions.md` A185).

**`buildSocket`/`buildUdpSocket`'s `pull()` derive bytes consumed from `desiredSize`, never
track it themselves.** A `ByteLengthQueuingStrategy`/`CountQueuingStrategy`'s own `desiredSize`
already equals `highWaterMark` minus the queue's current size, so the delta since the last
`pull()` is what the app has genuinely drained -- recoverable without duplicating what the
platform already tracks. `desiredSize` is `null` once the controller is no longer readable;
falling back to crediting `0` (never the whole window) means bytes that may be unread are never
credited. `buildUdpSocket`'s outbound `refusals` stream has no such credit window -- a refusal
is reported the instant the broker makes it, and `droppedOutbound` counts every one regardless,
so a full `refusals` queue drops a new refusal rather than growing without bound (A87);
`droppedInbound`/`droppedOutbound` are getters, not values copied once, because they move for
the socket's whole life and `Object.freeze` prevents redefining them, not reading them live.

**Refusing extension code at `window.orivon` (owner, 2026-09-29).** `main-world-socket.ts`'s
`installOrivon` wraps every page-callable leaf (`guarded`) so a call first attributes its caller
from a stack captured with intrinsics saved at install time, before any page or extension script
has run -- a later main-world tamper cannot reach `RealError`/`Reflect.defineProperty`/etc.
because they are locals, not properties read fresh off `window.Error` on every call. The
decision, over the CallSites excluding `guarded`'s own frame
(`Error.captureStackTrace`'s second argument does the excluding): refuse if any frame's file
name, script name or eval origin names a `chrome-extension://` script; otherwise refuse unless
some frame is page code (an `http:`/`https:` URL, a `blob:` URL whose inner origin is `http(s)`,
or an eval origin naming one); otherwise allow. Refusing when NO frame qualifies either way
(rather than only when one names an extension) is deliberate fail-closed default-deny: a
`setTimeout(orivon.x.bind(...))` scheduled by extension code fires with no caller stack at all,
and a stack that cannot be captured because `Error.prepareStackTrace`/`stackTraceLimit` was
frozen first is treated the same way, since neither can be told apart from `chrome-extension://`
code covering its own tracks. Measured on Electron 44 at about 5 microseconds a call:
`docs/planning/spike-results/extension-stack-probe.json`'s `mainWorld` entries. This is a
filter, not a sandbox -- what it does not catch is stated in the security model.

**`net.connect`/`net.connectSecure`'s own unwrapped implementations reach `../routed/dial.ts`
through a private symbol on `target`, never through `window.orivon.net`.** `dial.ts` is
serialised into the main world separately from `installOrivon` (`../routed/wire.ts`'s own
header) and calls net.connect from a callback with no page frame of its own -- exactly the shape
the check above refuses by design, so a routed `fetch()`/XHR/WebSocket would fail every dial if
it went through the guarded, page-facing `orivon.net`. `installOrivon` leaves the two
unwrapped closures at `target[Symbol.for('orivon.internal-net')]`, non-enumerable; that key
reaches the global symbol registry the same way `Symbol.for('orivon.routed-network')` already
does (`../routed/README.md`), so it is only ever live for the same short, uninterrupted
synchronous window that slot already relies on -- `../expose-fetch-route.ts`'s own
`exposeFetchRoute()` deletes it (via `../routed/core.ts`'s `releaseRoutedSlot`) before this
tab's own page script gets a turn, on every ordinary tab, whether or not it turns out to be an
app tab.
