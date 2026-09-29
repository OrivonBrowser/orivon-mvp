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

**Refusing extension code at `window.orivon`.** `main-world-socket.ts`'s
`installOrivon` wraps every page-callable leaf (`guarded`) so a call first attributes its caller
from a stack captured with intrinsics saved at install time, before any page or extension script
has run -- a later main-world tamper cannot reach `RealError`/`Reflect.defineProperty`/etc.
because they are locals, not properties read fresh off `window.Error` on every call. The same
install-time capture saves references to the four `CallSite.prototype` methods `mapFrames` reads
(`getFileName`/`getScriptNameOrSourceURL`/`isEval`/`getEvalOrigin`); every later call goes
through the saved `Reflect.apply` on the saved reference, never a live method lookup, and a live
method that no longer matches the saved one is itself treated as tamper, refused the same way a
frozen `Error.prepareStackTrace` is -- main-world code that obtains its own `CallSite` (its own
`prepareStackTrace`) cannot make a later frame lie about its origin by replacing a prototype
method. The decision, over the CallSites excluding `guarded`'s own frame
(`Error.captureStackTrace`'s second argument does the excluding): refuse if any frame's file
name, script name or eval origin CONTAINS a `chrome-extension://` script (refusing more is
safe); otherwise refuse unless some frame is page code -- checked STARTS-WITH, and only over the
frame's real script URL (`getFileName()`: an `http:`/`https:` URL, or a `blob:` URL whose inner
origin is `http(s)`) or an eval origin whose innermost script URL (the URL inside the last,
innermost `(...)` V8 nests a repeated eval origin in) starts with one of those. Page attribution
never reads `scriptNameOrSourceURL`: a `//# sourceURL=https://...` comment lets string-compiled
code (`eval`, `new Function`, a string passed to `setTimeout`) claim any script name it likes, so
that field is read only for the (safely broader) extension check above, never to decide a frame
is the page's own. Otherwise allow. Refusing when NO frame qualifies either way (rather than only
when one names an extension) is deliberate fail-closed default-deny: a
`setTimeout(orivon.x.bind(...))` scheduled by extension code fires with no caller stack at all,
and a stack that cannot be captured because `Error.prepareStackTrace` was frozen first, or whose
`stackTraceLimit` cannot be raised to `Infinity` for the capture -- frozen at 0, at some other
small value, or otherwise non-configurable, all count identically -- is treated the same way,
since none of these can be told apart from `chrome-extension://` code covering its own tracks.
Measured on Electron 44 at about 5 microseconds a call:
`docs/planning/spike-results/extension-stack-probe.json`'s `mainWorld` entries. This is a
filter, not a sandbox -- what it does not catch is stated in the security model.

**A known remaining route: page code that itself evaluates a string an
extension supplies.** If a page exposes an eval gadget of its own -- a function that runs a
string an extension handed it, scheduled by a `setTimeout` the extension controls so the call
has no extension frame on its stack at the moment it runs -- that string executes as the page's
own code, correctly attributed, and `window.orivon` allows it. This is not a gap in the filter:
the code really is running as the page by the time it calls `window.orivon`, the same as any
other case where an extension changes what a page's own script does (ADR-0045's Consequences).
It is stated here because the sourceURL-spoofing fix above narrows a nearby, easily-confused
route (extension code claiming to BE the page) and this one is easy to mistake for the same
thing.

**`orivon.ts`'s `exposeFallback()` is fail-closed, not merely `net`-less.** It runs when
`contextBridge.executeInMainWorld` is absent or throws -- `main-world-socket.ts`'s `installOrivon`
is the only place a caller is attributed to the page, so an extension's script refused (ADR-0045);
`exposeFallback` crosses `contextBridge.exposeInMainWorld` with no such attribution, and a page and
a MAIN-world extension script reaching a method there are indistinguishable. Every method it
builds (`deniedRejection`/`deniedThrow`) keeps its real shape -- an app's own `typeof
window.orivon.fs.open === 'function'` feature check still passes -- but refuses instead of
forwarding, and it logs once so a silently fail-closed `window.orivon` still shows in devtools.

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
