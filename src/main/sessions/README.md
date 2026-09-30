# `src/main/sessions/`: what an Electron `Session` is allowed to do

**What lives here.** `permission-gate.ts` denies every Chromium permission (camera, clipboard
reads, geolocation, ...) on every session a tab can reach, except the names in the table below,
plus one conditional case: `'media'` for a `chrome-extension://` origin redeeming a live
`chrome.tabCapture` grant (`tab-capture-grants.ts`'s own doc; wired from
[`../extensions/extension-host.ts`](../extensions/extension-host.ts)). `external-links.ts` and
`site-notifications.ts` decide the two that ask the person; `notification-decisions.ts` remembers
each site's notification answer; `tab-prompts.ts` is what each tab remembers between questions.
`web-context-host.ts` is `ADR-0019`'s Electron half of the isolated `WebContext`: the real
`WebContextHost` [`../../broker/capabilities/web.ts`](../../broker/capabilities/web.ts) calls
through `CreateBrokerOptions.webContextHost`. `web-request-owner.ts` is the one place anything
registers Electron's own `onBeforeRequest`/`onBeforeSendHeaders`/`onHeadersReceived` on a session
it covers, composing every registered handler through `web-request-compose.ts`'s pure ordering
logic; see this file's Design notes below. `session-attribution.ts` publishes
`ctx.senderAttributed` (`../registry.ts`): whether a WebContents is attributed to the origin it
claims, decided at that document's own commit and reused afterward rather than re-decided live,
reusing [`../shell/tab-view.ts`](../shell/tab-view.ts)'s own `partitionForTarget` rule so every
renderer-reachable broker channel can refuse a call whose WebContents never committed the origin
it claims in the session it belongs in.

**What it depends on.** `electron`, [`../../contracts/`](../../contracts/) (`LIMITS`),
[`../../broker/`](../../broker/) (`grants/origin-hash.ts`, `grants/node-ledger-storage.ts`'s
`writeFileAtomic`, `policy/origin.ts`, `broker-contracts.ts` types),
[`../../loader/electron/serve.ts`](../../loader/electron/serve.ts),
[`../../protocols/builtin.ts`](../../protocols/builtin.ts), [`../shell/`](../shell/) (the two
questions, `external-link-prompt.ts` and `notification-prompt.ts`; `showing-window.ts`;
`exclusive-access-notice.ts`; `lock-navigation.ts`; `tab-view.ts`'s `partitionForTarget`), the
top-level `registry.ts`. Only `permission-gate.ts`, `web-context-host.ts`, `web-request-owner.ts`
and `session-attribution.ts` import `electron`: the decision files, `web-request-compose.ts`
included, are unit-tested under plain vitest.

**What it must never import.** Nothing security-relevant about an isolated context may live in
[`../../broker/capabilities/web.ts`](../../broker/capabilities/web.ts) instead: that file stays
Electron-free by its own rule, which is why this directory exists. The partition, the view
construction and the network confinement have to live somewhere Electron-shaped, and this is it.

**Durable or tied to Electron.** `permission-gate.ts`, `web-context-host.ts`,
`web-request-owner.ts` and `session-attribution.ts` are tied to Electron's `Session`; the decision
files (`web-request-compose.ts` included), the notification store and `tab-capture-grants.ts` are
plain Node and would survive an engine change.

**Owner stream.** `shell` (`permission-gate.ts`, `session-attribution.ts`); `ADR-0019`
(`web-context-host.ts`). Maintenance only.

## Design notes

**[`permission-gate.ts`](permission-gate.ts): wired through `app.on('session-created', ...)`,
not at any one session's construction site.** Electron fires that event once for every `Session`
it instantiates, `session.defaultSession` included, so one listener reaches partitions no code
has created yet; a `partitionFor(origin)` session comes into being only for a cache-served
origin, as its tab opens. A handler in
`makeTabView()` would miss the default session (the chrome UI, the dashboard, rejected tabs).
The subsystem is listed first in `subsystems.ts` so its `beforeReady` attaches the listener
before any other subsystem can create a session.

**What the gate allows, and the rule a name must meet.** Every name not in this table is refused.
A name passes on one of two grounds (A202; `ADR-0025` has the amended wording):

1. **The platform gates it and the shell answers its abuse.** The web platform gates it on an
   action by the person the shell can neither fake nor suppress, and either (a) a legacy path
   already grants the same power, or (b) its one abuse is answered by an affordance the shell
   draws, as every browser does.
2. **The person answers a real prompt**, in the window showing the page, naming the site that
   asks. Nothing passes before the answer, and the check handler, which cannot ask, never allows
   on the person's behalf.

**`media` meets neither ground, and is not in the table below for that reason: it stays denied
for an ordinary page.** The one case it passes is a THIRD ground: an extension itself already
proved a legitimate capture request by calling the permission-gated `chrome.tabCapture` API,
which is what `tab-capture-grants.ts` checks for. No person is asked, because the person's own
consent already happened once, at install, over the `tabCapture` permission line the install
prompt showed. That carve-out is narrower than "this extension holds a live grant": the REQUEST
handler's own `contents` argument must be the exact tab the grant named, the request's own
`mediaTypes` must be empty, and the request must be from the requesting page's own MAIN frame.
A device request (`getUserMedia({ audio: true })`, say) fires with `contents` as the extension's
OWN page and a non-empty `mediaTypes`, so a live tabCapture grant never widens into real
microphone/camera access on its own page. `mediaTypes` alone is not enough, though: MEASURED,
`getUserMedia({ mandatory: { chromeMediaSource: 'desktop' } })` ALSO reports `mediaTypes: []`, and
a web-accessible `chrome-extension://` page the extension injects as an `<iframe>` into the SAME
tab it minted a grant for shares that tab's own `contents` (an iframe is a frame within a page's
one `WebContents`, never a separate `WebContents`), matching the grant on both signals otherwise
checked -- `isMainFrame` is what the legitimate flow always has and an iframe's own request never
does. The CHECK handler answers `false` for `'media'` unconditionally: it fires speculatively,
with no real call behind it, and carries neither the captured tab's identity nor the request shape
to check either signal against.

| Name | Ground | What meets it | ADR |
|---|---|---|---|
| `clipboard-sanitized-write` | 1(a) | Transient activation in a focused document; `document.execCommand('copy')` | `ADR-0022` |
| `fileSystem`, one file | 1(a) | The OS picker, a drop or a paste; `<input type="file">` and downloads | `ADR-0024` |
| `fullscreen` | 1(b) | A click; Escape in the browser process; "Press Esc to exit full screen" | `ADR-0025` |
| `pointerLock` | 1(b) | A click; Escape in the browser process; "Press Esc to show your cursor" | `ADR-0026` |
| `keyboardLock` | 1(b) | Acts only in fullscreen, which a click enters; holding Escape leaves; "Press and hold Esc to exit full screen" | `ADR-0026` |
| `openExternal` | 2 | "Open *scheme* link with your system's default app?", every time | `ADR-0027` |
| `notifications` | 2 | "*site* wants to show notifications", once per site, remembered | `ADR-0028` |

Which handler Electron routes each name to was measured, and each ADR records it. Two traps
follow from it:

- **File System Access reaches the check handler alone.** The request handler applies the same
  one-file predicate anyway, so a later Electron routing a call through it cannot open what the
  check handler refuses (`ADR-0024`).
- **Electron draws no notice for pointer or keyboard lock**, so
  [`../shell/exclusive-access-notice.ts`](../shell/exclusive-access-notice.ts) does. It learns a
  tab is in fullscreen from the tab's own events, watched from the `fullscreen` grant onward, so
  the gate notes a grant before answering it (`ADR-0026`).

The notification measurement is the last phase of `test/e2e-site-permissions.test.ts`, which
runs only on a private session bus
([`setup.md`](../../../docs/development/setup.md)):
`ORIVON_PRIVATE_BUS=1 node scripts/run-headless.mjs npx vitest run --config test/vitest.e2e.config.ts test/e2e-site-permissions.test.ts`.

**`web-context-host.ts` reinstalls deny-everything handlers on isolated-context sessions.** They
are the only thing keeping every name above away from a document running another site's script;
they look like duplication and are not. The grant ledger is untouched by the gate: it governs
`orivon.*` capabilities, not Chromium's own.

**[`session-attribution.ts`](session-attribution.ts) decides attribution at a document's own
commit, never by re-checking a live document against the CURRENT state.** A live re-check
sounds simpler, but it strands every already-open, already-attributed document of an origin the
instant that origin's session changes: an origin whose pinned copy goes away moves from its own
partition back to the default session, and a tab still showing it would be denied even
`app.requestGrant`, because its `WebContents` never moves on its own. A grant or a revoke does
not move an origin at all: a granted network-served origin runs in the default session
(`ADR-0044`), exactly where an ungranted one runs. Recording what a document's session
was found to be at its own last main-frame `did-navigate`, and trusting that record afterward,
lets an already-attributed document keep calling successfully until it next navigates -- the same
navigation that already triggers `../shell/tab-view.ts`'s own partition swap for any other
cross-origin move. A cache-served (pinned) origin is the one exception, checked live and strictly
regardless of any record, because its bundle is only ever intercepted inside its own partition
(`ADR-0007`): a document attributed to it must run there at every call, not merely at whatever
moment it committed.

**[`web-context-host.ts`](web-context-host.ts): two WebRTC belts, and why the discard-port
proxy does not break the context's own `fetch()`.** `protocol.handle` and
`webRequest.onBeforeRequest` cover what passes through Electron's request layer; WebRTC's
ICE/STUN/TURN dial does not (A41). A context has no reason to use WebRTC, so it is closed twice:
`setWebRTCIPHandlingPolicy('disable_non_proxied_udp')`, and `session.setProxy` pointed at
`http://127.0.0.1:9`, where nothing answers. A request `protocol.handle` answers never reaches
proxy resolution, so the proxy sees only what those handlers did not intercept.
`test/e2e-web-context-network.test.ts` proves a granted `fetch()` still gets a real response
with both belts active.

**[`web-request-owner.ts`](web-request-owner.ts): one owner per (session, event), because
Electron keeps only the LAST registration.** A second `session.webRequest.onHeadersReceived(...)`
call for a session that already has one silently replaces it rather than adding to it, so two
independent features registering directly on the same session would fight over which one runs.
`webRequestOwnerFor(session)` is the one place that ever calls Electron's own
`onBeforeRequest`/`onBeforeSendHeaders`/`onHeadersReceived`; every caller instead registers a
handler with an `order`, a `WebRequestFilter` and a URL predicate, and `web-request-compose.ts`'s
pure logic runs them in order, threading each one's result to the next. Used for
`session.defaultSession` today: the verifier's partition stamp (`../verifier/verifier-
subsystem.ts`), the granted-origin CSP (`../install/granted-origin-csp.ts`), the Firefox
request headers on Google's sign-in hosts (`../shell/sign-in-identity-headers.ts`) and the three
`declarativeNetRequest` handlers (`../extensions/dnr-webrequest.ts`). The embed session
([`../embed/embed-host.ts`](../embed/embed-host.ts)), the internal-pages session
([`../pages/internal-session.ts`](../pages/internal-session.ts)) and an isolated `WebContext`
session (`web-context-host.ts`, above) register directly instead: each is the only thing that
ever touches its own session's `webRequest`, so there is nothing there for an owner to arbitrate.

**Each registration returns a handle whose `remove()` takes that one handler back out.** Most
callers never need it (the verifier's partition stamp and the granted-origin CSP watch every
request for the process's whole life), so most ignore the return value; `dnr-webrequest.ts` is
the one that does not -- a person with no `declarativeNetRequest` extension loaded should not pay
for a webRequest round trip that always has nothing to do. `remove()` re-registers Electron's own
listener from whatever handlers remain, the same `unionFilter` recomputation adding one already
triggers; with nothing left for an event, that means calling Electron's `onXxx(null)` to actually
unregister the listener, not registering it again with an empty `{ urls: [] }` filter -- Electron
does not read an empty pattern list as "match nothing," so only `null` actually stops the round
trip.

**Every handler declares its own `WebRequestFilter`; the owner never leaves Electron's own
listener unfiltered.** Registering with no `{ urls }` filter at all means every single request on
the session pays a round trip into this process, whether or not anything could possibly match --
`unionFilter` (`web-request-owner.ts`) combines every currently-registered handler's own filter
into the one Electron's listener is (re-)registered with, each time a handler is added. A handler
whose own predicate is broader than any URL pattern can express (the granted-origin CSP: a grant
can land on any origin, ADR-0044) says so plainly with `{ urls: ['<all_urls>'] }`, narrowed by
`types` instead when the handler only ever acts on certain resource types -- `unionFilter` never
lets a narrower sibling's `types` accidentally restrict a handler that asked for every type.

**`onBeforeSendHeaders`/`onHeadersReceived` answer with a bare `{}` when nothing changed, never a
seeded header set.** Electron reads a `responseHeaders`/`requestHeaders` key that IS present as
"replace the headers with exactly this," even when its value is identical to what the response
already carried -- a response with none at all (`details.responseHeaders` undefined) answered
with an explicit `{}` object gets every real header it does have stripped. The owner tracks this
by identity: the seed object built for each event is never handed back if some handler actually
returned a new one; an unchanged result (no handler matched, or every one that ran chose to leave
its input alone) answers with a bare `{}` instead.
