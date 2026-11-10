# `src/main/sessions/`: what an Electron `Session` is allowed to do

**What lives here.** `permission-gate.ts` denies every Chromium permission (camera, clipboard
reads, geolocation, ...) on every session a tab can reach, except the names in the table below
(`allowed-permissions.ts`), plus one conditional case: `'media'` for a `chrome-extension://`
origin redeeming a live `chrome.tabCapture` grant (`tab-capture-media.ts`, with
`tab-capture-grants.ts`'s own doc; wired from
[`../extensions/extension-host.ts`](../extensions/extension-host.ts)). Before its own rules the
gate asks `site-asks.ts`, a registry of per-site askers: each answers only the permissions it owns,
only for a tab, and answers `undefined` otherwise, so the gate's rules decide. An asker may be added first (`addFirst`) when
it must see a request before the general askers do, and may hear every grant once the gate has told
Electron (`afterGrant`). `device-permission-handler.ts` is the slot `setDevicePermissionHandler` points at: it answers no for every device until [`../devices/`](../devices/) binds the handler for a HID device, and no for USB and serial always. `display-media-handler.ts` is the slot `setDisplayMediaRequestHandler`
points at on every session: it answers no stream (the page's call fails) until
[`../display-capture/`](../display-capture/) binds the handler that gives the source the person picked. `wake-lock-asker.ts` is the asker that owns `screen-wake-lock` (`ADR-0090`): yes for a tab's top frame, no for any other contents or frame, never a question.
`external-links.ts` and
`site-notifications.ts` decide the two that ask the person; `notification-decisions.ts` remembers
each site's notification answer; `tab-prompts.ts` is what each tab remembers between questions.
`web-context-host.ts` is `ADR-0019`'s Electron half of the isolated `WebContext`: the real
`WebContextHost` [`../../broker/capabilities/web.ts`](../../broker/capabilities/web.ts) calls
through `CreateBrokerOptions.webContextHost`. `web-request-owner.ts` is the one place anything
registers Electron's own `onBeforeRequest`/`onBeforeSendHeaders`/`onHeadersReceived` on a session
it covers, composing every registered handler through `web-request-compose.ts`'s pure ordering
logic; see this file's Design notes below. `own-listener-media-gate.ts` is `ADR-0069`'s Electron half:
it cancels a loopback image or media request from a page that holds a `tcp.listen` grant when the
port is not one its own listeners hold, on the default session and on each session an app is served
from, with the pure decision in [`../../broker/policy/own-listener-media.ts`](../../broker/policy/own-listener-media.ts).
`local-node-port-gate.ts` cancels, in every session, a request from any page to a loopback port a local node holds
(`local-node-ports.ts` is the pure decision), so no page can time a node that keeps what it fetched.
`network-service-restart.ts`, `network-service-recovery.ts`, `network-service-hold.ts` and `network-service-runner.ts` keep what Orivon set on Chromium's network service across its restart (the first Design note below): the hold on requests and its bound, the order of a recovery with the probe of each session that says its context is the new one, the one hold of the process, and the Electron wiring that listens for the process ending and sends each registered setting again (`reapplyAfterNetworkServiceRestart` for secure DNS and the verifier host, `reapplyToSessionsAfterNetworkServiceRestart` for the verifier's certificate check). `network-service-test-seam.ts` is what a test build exposes of all this.
`app-files-by-url.ts` is `ADR-0070`'s Electron half: on the same sessions it redirects an app page's image or
media request for `/orivon/app/<path>` to the `orivon-file:` scheme and answers that scheme with the app's own
file (`app-file-response.ts`, no Electron in it), with the pure decision in
[`../../broker/policy/app-files-by-url.ts`](../../broker/policy/app-files-by-url.ts).
`shell-answered.ts` notes which main-frame document the shell answered, for `session-attribution.ts`. `worker-control.ts` keeps what a tab's top frame reported about a controlling service worker (`../../preload/worker-control.ts`), and `app-workers.ts` is the rule that, for an origin the shell serves where websites run, only a worker script the shell served may be registered (`ADR-0111`; the response hook is `../verifier/partition-stamp.ts`'s `installWorkerScriptGuard`, and `website-workers-subsystem.ts` arms it for an origin just before the serving is prepared). `worker-settle.ts` is the order in which an origin the shell serves where websites run settles before a worker's answer counts as the app's, and `stale-pages.ts` is what runs it for each origin newly served and the way a page is loaded again (see the paragraph on `worker-settle.ts` below).
`website-sessions.ts` is the list of sessions a website runs in (the default one, and the tunnel profile and the direct profile a website with an entry of its own lives in, `../route/`): a control that guards or adjusts a website's requests installs through `forEachWebsiteSession`, so a website that moves into a profile keeps it, and a session missing one is refused.
`session-attribution.ts` publishes
`ctx.senderAttributed` (`../registry.ts`): whether a WebContents is attributed to the origin it
claims, decided at that document's own commit and reused afterward rather than re-decided live (except a cache-served origin and a local file, checked live),
reusing [`../shell/tab-partition.ts`](../shell/tab-partition.ts)'s own `partitionForTab` rule (with the tunnel choice of the tab the contents belongs to) so every
renderer-reachable broker channel can refuse a call whose WebContents never committed the origin
it claims in the session it belongs in. A local file's key is attributed only while the tab's session is the
one `localPartitionFor` names ([`../local-files/`](../local-files/)), checked at every call: the path of
a document is fixed for its life, so only the session can be wrong.

**What it depends on.** `electron`, [`../../contracts/`](../../contracts/) (`LIMITS`),
[`../../broker/`](../../broker/) (`grants/origin-hash.ts`, `grants/node-ledger-storage.ts`'s
`writeFileAtomic`, `policy/origin.ts`, `broker-contracts.ts` types),
[`../../loader/electron/serve.ts`](../../loader/electron/serve.ts),
[`../../protocols/builtin.ts`](../../protocols/builtin.ts), [`../shell/`](../shell/) (the native
question `external-link-prompt.ts`; `showing-window.ts`;
`exclusive-access-notice.ts`; `lock-navigation.ts`; `tab-partition.ts`'s `partitionForTab`), [`../route/`](../route/)'s `tab-tunnel.ts` (`tabChoiceOfContents`, the tunnel choice of a tab, which the shell supplies), [`../local-files/`](../local-files/)'s `partition.ts`, the
top-level `registry.ts`. Only `permission-gate.ts`, `web-context-host.ts`, `web-request-owner.ts`,
`own-listener-media-gate.ts`, `local-node-port-gate.ts`, `network-service-runner.ts`, `app-files-by-url.ts` and `session-attribution.ts` import `electron`: the decision files, `web-request-compose.ts`
included, are unit-tested under plain vitest.

**What it must never import.** Nothing security-relevant about an isolated context may live in
[`../../broker/capabilities/web.ts`](../../broker/capabilities/web.ts) instead: that file stays
Electron-free by its own rule, which is why this directory exists. The partition, the view
construction and the network confinement have to live somewhere Electron-shaped, and this is it.

**Durable or tied to Electron.** `permission-gate.ts`, `web-context-host.ts`,
`web-request-owner.ts`, `own-listener-media-gate.ts`, `app-files-by-url.ts` and `session-attribution.ts` are tied to Electron's `Session`; the decision
files (`web-request-compose.ts` included), the notification store and `tab-capture-grants.ts` are
plain Node and would survive an engine change. `network-service-runner.ts` is tied to Electron (`child-process-gone`, the sessions, the network service itself); the hold's state machine, the order of a recovery and the process's one hold (`network-service-restart.ts`, `network-service-recovery.ts`, `network-service-hold.ts`) are plain Node, durable as code though what they keep across is Chromium's network service; `network-service-test-seam.ts` is plain Node too and compiled out of an ordinary build.

**Owner stream.** `shell` (`permission-gate.ts`, `session-attribution.ts`); `ADR-0019`
(`web-context-host.ts`). Maintenance only.

## Design notes

**[`tab-capture-media.ts`](tab-capture-media.ts) decides a `media` request by the tab it names, and allows nothing in the check handler.** `media` stays denied by default (a page asking for the camera or the microphone); the one carve-out is the `getUserMedia({ audio: { mandatory: { chromeMediaSource: 'tab', ... } } })` call `chrome.tabCapture` itself makes. Measured: the request handler's own `contents` argument is the CAPTURED tab's `webContents`, not the requester's, for this call shape, and only `details.securityOrigin` names the requesting `chrome-extension://` origin. A real device request (`getUserMedia({ audio: true, video: true })` on the extension's own page) hands `contents` as the calling page and carries `mediaTypes` naming what it asked for, where a tab-capture request's `mediaTypes` measures empty. `isTabCaptureMediaRequestAllowed` checks `contents.id` against the exact tab the extension's `getMediaStreamId()` named, `mediaTypes` empty and `details.isMainFrame`. Without the first two, an extension holding one live grant could call `getUserMedia({ audio: true, video: true })` on its own page and receive the real microphone and camera. `isMainFrame` closes a gap those two leave: `getUserMedia({ mandatory: { chromeMediaSource: 'desktop' } })` also measures `mediaTypes: []`, and a web-accessible extension page injected as an `<iframe>` into the tab a grant names shares that tab's `contents.id` (a page and its iframes are one `WebContents`); `tab-capture-grants.ts`'s own doc has the full measurement. Allowing the request is also the one real signal that a genuine `getUserMedia('tab')` is in flight for the grant, so it is marked consumed on the way out and the safety net in `tab-capture.ts` stops treating the (extension, tab) pair as maybe never redeemed, however long the capture runs. The check handler must never mark it, and must never allow `media` at all: `setPermissionCheckHandler` fires repeatedly and speculatively for a `chrome-extension://` page (device probing by the library's own preload or Chromium's enumeration) with no `getUserMedia()` behind it, carries no captured-tab identity even when it does match a real call, and its singular `details.mediaType` cannot tell tab capture from a device the way the request handler's exact `mediaTypes` list can.

**[`network-service-runner.ts`](network-service-runner.ts) sends Chromium's network service its settings again when it restarts, and holds requests until it has.** The network service is a process of its own. When it ends (a crash, an out-of-memory kill, a signal) Chromium starts another, and the new one has nothing Orivon set on the old: the certificate check the verifier's pages need (`setCertificateVerifyProc`) and secure DNS (`app.configureHostResolver`; Electron gives a new service secure DNS off, so lookups go out in plain text). The web-request listeners and `protocol.handle` handlers live in the browser process and are untouched. What the old process held is gone and is not Orivon's to restore: session cookies and the in-memory cookies of a partition, open WebSockets, requests in flight, downloads under way.

The order is in `network-service-recovery.ts`. (1) On `child-process-gone` for `network.mojom.NetworkService`, the hold begins: the owner (`web-request-owner.ts`) puts a handler ahead of every other `onBeforeRequest` handler on the default session and each tunnel session, which waits for the hold to end, so no request that passes those listeners reaches certificate verification or DNS meanwhile; the embedded-page session registers its own listener, which a second one would replace, so that listener waits on `holdWhileNetworkServiceRestarts` itself, before it looks a name up. A request that went on first would be judged by the defaults, and Chromium keeps a verdict for a host for minutes, whatever check is set later. (2) The new service is waited for, session by session: `resolveHost('127.0.0.1')` is asked of every session until it answers (`untilAnswered`), because a call made inside the event is bound to the context that has just died, and a call a moment later is refused or never answered; a fixed sleep cannot show that the new context exists, and one session's answer says nothing of another's context. (3) Each registered setting is sent when its proof is in. A setting of the service as a whole is sent once the default session answers: secure DNS with the options last applied, and putting the verifier host to sleep, since the host's own `net` context ended with the service and does not come back (its next fetches stall for seconds or fail until the process is replaced, and its next request starts a new one; sleeping it also stops the IPFS and Swarm nodes, which start again at their next ask). A setting of a session, the verifier's certificate check, is sent to that session when its own probe answers, never before: on a context that is about to be dropped it would be lost, and every `.eth` page in that session refused for the rest of the run. The sessions are read as the probes go, so one made during the hold is asked too. A failure of one setting does not stop the others. (4) The hold ends when the default session and the sessions that answer within a second of it (`OTHERS_GRACE_MS`) have been sent theirs, so a session nobody uses cannot delay the rest, and the waiting requests go on. A session that has not answered by then keeps being asked up to the bound and is sent its settings when it does; the log says how many answered after the release and how many never did (`k of N sessions did not answer`), and a request on such a session runs with the defaults until then. A hold is bounded (`HOLD_BOUND_MS`, five seconds, far above the fraction of a second a restart takes): at the bound the requests go on without the settings and the log says so. A new service starts with secure DNS off in every mode, so until the settings arrive lookups go out in plain text under strict secure DNS, under automatic mode and under the Quad9 fallback alike. A second end during a hold starts the bound again and leaves the sending to the later one, so a service that keeps ending holds requests for three bounds at most.

A request started after the process died and before Chromium replaces the session's loader factory fails at once with `ERR_FAILED` and never reaches a listener, so no hold can catch it; the person reloads, as in any browser. A request that reaches the web-request proxy on a new loader factory before main has run the `child-process-gone` task is not held either. The hold covers the requests that pass the web-request listeners of the default and tunnel sessions and of embedded pages. It does not cover main's own network use (the loader's and the verifier's fetches through `net`, the Quad9 fallback probe) or a session that is not a website's (a web context, an internal page, a child window), so from the new service's start until its settings are sent those can still resolve a name in plain text; they are sent the settings like the rest. Each step is a `[network-service]` line in the log that `orivon://report` carries (the end, the time the settings took and what was sent, the requests that waited, a timeout), a network service killed outside a quit is a record in `diagnostics.recentCrashes`, and `diagnostics.browser.networkService` counts the restarts, the holds that ended at the bound and how the latest ended, which the log's 1,000 lines cannot promise after a long run. A test build exposes `__orivonDevNetworkService` (the ends, the sends, each resolver call, each certificate check, each hold's outcome) and two delays, because Chromium offers no read of the resolver and the hold lasts a fraction of a second.

**[`app-files-by-url.ts`](app-files-by-url.ts) redirects instead of answering, on purpose.** An app's files
have to reach a page of a granted loopback origin on the shared session, and `protocol.handle('http')` there
would route every `http:` request of every tab through JavaScript. A web-request handler filtered to
`/orivon/app/` images and media redirects the one verified request to `orivon-file:` (measured on Electron 44:
the redirect crosses origins, `img-src`/`media-src` check its target, `Range` reaches the scheme handler and a
media element seeks). A cache-served app's session sees the same request through the handler's `onBeforeRequest`
before its own scheme handler does. The scheme is open to every page of those sessions, so the URL carries a
MAC over origin and path that only this process makes: without it a page could name another app's file.
The handle comes from `Broker.fs.open`, which confines and checks the grant again at the read.

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
for a page that is not a website the person is asked about or an extension's own page.** Two cases
pass it. A website is asked once per site (`../site-settings/`). An installed extension's own top page
that asks for the camera or the microphone (`mediaTypes` naming only `video` and `audio`) is asked per
extension and device by `../extensions/extension-media-asker.ts`, which registers first in `site-asks.ts`
and answers on ground 2: the sheet is over the window that shows the page, a page no window shows (an
offscreen document, a hidden window) gets only a stored allow, a frame never asks, and the check
handler answers true only for a stored allow. The other is a THIRD ground: an extension itself already
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
does. For a tab capture the CHECK handler answers `false` unconditionally: it fires speculatively,
with no real call behind it, and carries neither the captured tab's identity nor the request shape
to check either signal against.

| Name | Ground | What meets it | ADR |
|---|---|---|---|
| `clipboard-sanitized-write` | 1(a) | Transient activation in a focused document; `document.execCommand('copy')` | `ADR-0022` |
| `fileSystem`, one file | 1(a) | The OS picker, a drop or a paste; `<input type="file">` and downloads | `ADR-0024` |
| `fullscreen` | 1(b) | A click; Escape in the browser process; "Press Esc to exit full screen" | `ADR-0025` |
| `pointerLock` | 1(b) | A click; Escape in the browser process; "Press Esc to show your cursor" | `ADR-0026` |
| `keyboardLock` | 1(b) | Acts only in fullscreen, which a click enters; holding Escape leaves; "Press and hold Esc to exit full screen" | `ADR-0026` |
| `screen-wake-lock` | 1(b) | Chromium offers it to a secure context only; the tab's preload releases a lock when the shell hides the tab, which Chromium never does for a tab behind another (`../../preload/page-visibility.ts`); owned by `wake-lock-asker.ts`, so only a tab's top frame passes; `system-wake-lock` stays denied | `ADR-0090` |
| `openExternal` | 2 | "Open *scheme* link with your system's default app?", every time; never asked for a page an app shows in a `<webview>`, which is refused (`ADR-0047`) | `ADR-0027` |
| `notifications` | 2 | "*site* wants to show notifications", once per site, remembered; asked in the per-site prompt under the address bar | `ADR-0028` |

**`screen-wake-lock` is in the table but not in `allowed-permissions.ts`.** Its answer depends on the contents (an ordinary
tab) and the frame (the top one), which a name and its details cannot say, so `wake-lock-asker.ts` owns it and the
gate's own rules deny it for whatever the asker does not answer. The grant is only as safe as the release in the
tab's preload: remove that and a tab behind another keeps the screen on.

**Names a per-site asker owns.** `media` (camera and microphone, one question for both),
`clipboard-read` and `deprecated-sync-clipboard-read`, `geolocation`, `midi` and `midiSysex`,
`idle-detection` and `window-management` are answered first by the asker
[`../site-settings/`](../site-settings/) registers, and only for an ordinary tab on an `http(s)`
site that holds no grants. A main frame asks once per site and the answer is remembered; a
frame never asks and gets only its own page's stored allow; the check handler reads the stored
answers and never asks. Anything the asker does not own, or any contents that is not a tab (an
extension's page, a shell view, an embed), falls through to this table, where none of these names
passes.

What a page's own `navigator.permissions.query` reads is the registry's `query`, not the check handler's answer: Electron
can only report true or false there, so an undecided name would read `denied` where a request would ask. An asker says
`granted`, `denied` or `prompt` from the decision a request from the same page takes, and
[`permission-query-ipc.ts`](permission-query-ipc.ts) hands it to the top frame's preload, which asks only when the engine's
own answer is `denied` and so can only turn it into `prompt` (the `site-settings/` README has the rules). The origin is the
sender frame's own, read by [`top-frame-origin.ts`](top-frame-origin.ts) (the one place a page's message is taken to speak for its top
frame, which the WebGPU question in [`../site-settings/`](../site-settings/) uses too), and a message holds one name; a frame other than the top one, an unknown name or an error is answered
with nothing, and the engine's answer stands.

Which handler Electron routes each name to was measured, and each ADR records it. Two traps
follow from it:

- **File System Access reaches the check handler alone.** The request handler applies the same
  one-file predicate anyway, so a later Electron routing a call through it cannot open what the
  check handler refuses (`ADR-0024`).
- **Electron draws no notice for pointer or keyboard lock**, so
  [`../shell/exclusive-access-notice.ts`](../shell/exclusive-access-notice.ts) does. It learns a
  tab is in fullscreen from the tab's own events, watched from the `fullscreen` grant onward, so
  the gate notes a grant before answering it (`ADR-0026`).

The notification measurement is the last phase of `test/sites/e2e-site-permissions.test.ts`, which
runs only on a private session bus, which `scripts/run-headless.mjs` gives every run off CI
([`setup.md`](../../../docs/development/setup.md)):
`node scripts/run-headless.mjs npx vitest run --config test/vitest.e2e.config.ts test/sites/e2e-site-permissions.test.ts`.

**`web-context-host.ts` reinstalls deny-everything handlers on isolated-context sessions.** They
are the only thing keeping every name above away from a document running another site's script;
they look like duplication and are not. The grant ledger is untouched by the gate: it governs
`orivon.*` capabilities, not Chromium's own.

**[`website-workers.ts`](website-workers.ts) clears what a website left at an origin before the app is served there.** An allowed app that runs in the shared session was a website there first, and a service worker or a Cache Storage entry that website installed would answer the app's requests with bytes the declared tree never checked. The preparer in [`website-workers-subsystem.ts`](website-workers-subsystem.ts) (listed above the loader in `../subsystems.ts`, so the pinned apps the loader restores at a start are prepared by it too) removes both each time the app is served live, and once when it is served from its pin at a start (an app that moved here from a partition of its own finds the website's workers already in the shared session); a file per origin in `website-workers-cleared-v2/` of the profile says it has been done, so the workers the app registers itself are left alone after (`ADR-0108`). The directory is named for the rule it was written under: a mark of an earlier rule is never read (and its directory is removed), so a pinned app whose origin an earlier build cleared is cleared once more, with the worker-script guard armed. The data the site kept (cookies, local storage, databases) stays, since one origin has one set of data, and the app registers its own worker through the check.

**[`worker-settle.ts`](worker-settle.ts) says when a worker's answer counts, and its order is the point (`ADR-0111`).** A document of the origin that the shell did not answer (a website's page the host answered before it was told, one open before Allow, a first visit's own tab) can write Cache Storage, which the app's worker would then answer with, past the check the declared tree gets. So an origin settles in this order, and no no-response, worker-controlled document counts as the app's before step 4: (1) the verifier host is told what the shell serves and says it applied that (`../verifier/shell-serves.ts`'s `servedKnownToHost`), after which every page it loads for the origin is the shell's; (2) every website page of the origin open then, in any session, is loaded again, except a document the shell answered and the storage carry's hidden page, and the tab a first visit is sending in is emptied by the visit (under its setup cover) and waited for instead; (3) when any such page existed, the origin's service workers and Cache Storage are removed in every session a website at the origin ran in; (4) the origin is marked settled, and a document counts only if it committed after step 3 (a clock of commits and settlings keeps the order, so a document the removal did not precede never counts, however long it lives). Each wait is bounded (`website-workers-subsystem.ts`'s `LIMITS`, *provisional*), a bound that runs out leaves the origin unsettled and its worker's answers without grants, and the next attempt starts after a delay that doubles from 3 s to a minute for as long as the origin is served. A first visit lets its tab in when the first attempt ends, settled or not, so the app opens. A page opened and closed wholly before the host was told, or between the reload and the removal, is not seen; the removal also takes the app's first worker registration when it lands between a page's reload and the removal (the next load registers it again).

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
regardless of any record, because its bundle is only ever intercepted in the session it is served in
(`ADR-0007`): a document attributed to it must run in that session at every call, not merely at whatever
moment it committed. That session is the app's own partition, or the shared one for an app the verifier
hands to the shell (`../shell/app-session.ts`'s `runsAsWebsite`, `ADR-0108`). A document there is the app's only
if the shell's own handler answered it ([`shell-answered.ts`](shell-answered.ts): the verifier marks what it relayed,
the session's response watch notes the mark of a page's main-frame response, and the commit takes it once) and the view
was built as the app's tab (`../shell/tab-partition.ts`'s `appTabContents`). A page that committed before the origin was
served, a first visit's page left open in another tab, and a document the host answered itself before it was told the
shell serves the app are websites, not the app, so they are denied. The record keeps what answered the document (the shell,
the network or the HTTP cache, or no response the session saw), and an origin served where websites run attributes nothing
else, even after it stops being served. The one other document attributed is a page the app's own service worker answered
(`ADR-0111`): a navigation a worker handles reaches no web-request hook, so the record says no response was seen, and the tab's
preload reports that a worker controls the document (`worker-control.ts`; the page's scripts cannot change what the
isolated world reads, and main takes the report only from the top frame, for the committed address, until the next navigation
starts). That is enough because no worker script the shell did not serve can be registered at a served origin
(`app-workers.ts`, armed before the website's workers are removed) and because the answer counts only from a document that committed after the origin settled (`worker-settle.ts`). A document the network or the cache answered is denied
whatever controls it, and so is one with no response and no controller. A local file is the other: the path of a document is fixed for its life, so
only its session can be wrong, and that must be the one `localPartitionFor` names at this call (a
record removed since the commit denies the document at once).

**[`web-context-host.ts`](web-context-host.ts): two WebRTC belts, and why the discard-port
proxy does not break the context's own `fetch()`.** `protocol.handle` and
`webRequest.onBeforeRequest` cover what passes through Electron's request layer; WebRTC's
ICE/STUN/TURN dial does not (A41). A context has no reason to use WebRTC, so it is closed twice:
`setWebRTCIPHandlingPolicy('disable_non_proxied_udp')`, and `session.setProxy` pointed at
`http://127.0.0.1:9`, where nothing answers. A request `protocol.handle` answers never reaches
proxy resolution, so the proxy sees only what those handlers did not intercept.
`test/capabilities/e2e-web-context-network.test.ts` proves a granted `fetch()` still gets a real response
with both belts active.

**[`web-request-owner.ts`](web-request-owner.ts): one owner per (session, event), because
Electron keeps only the LAST registration.** A second `session.webRequest.onHeadersReceived(...)`
call for a session that already has one silently replaces it rather than adding to it, so two
independent features registering directly on the same session would fight over which one runs.
`webRequestOwnerFor(session)` is the one place that ever calls Electron's own
`onBeforeRequest`/`onBeforeSendHeaders`/`onHeadersReceived` or one of the five observer events
(`onSendHeaders`, `onResponseStarted`, `onBeforeRedirect`, `onCompleted`, `onErrorOccurred`); every caller instead registers a
handler with an `order`, a `WebRequestFilter` and a URL predicate, and `web-request-compose.ts`'s
pure logic runs them in order, threading each one's result to the next. Used for
the sessions a website runs in (`website-sessions.ts`) today: the verifier's partition stamp (`../verifier/verifier-
subsystem.ts`), the granted-origin CSP (`../install/granted-origin-csp.ts`), the Firefox
request headers on Google's sign-in hosts (`../shell/sign-in-identity-headers.ts`) the privacy and content-setting handlers, and, on `session.defaultSession` alone, the three
`declarativeNetRequest` handlers (`../extensions/dnr-webrequest.ts`) and the extension `webRequest`
dispatcher (`../extensions/web-request-dispatch.ts`). The embed session
([`../embed/embed-host.ts`](../embed/embed-host.ts)), the internal-pages session
([`../pages/internal-session.ts`](../pages/internal-session.ts)) and an isolated `WebContext`
session (`web-context-host.ts`, above) register directly instead: each is the only thing that
ever touches its own session's `webRequest`, so there is nothing there for an owner to arbitrate.

**The five observer events fan out and answer nothing.** Electron's `onSendHeaders`,
`onResponseStarted`, `onBeforeRedirect`, `onCompleted` and `onErrorOccurred` listeners take no
callback, so there is no result to compose and no order to keep: every handler whose predicate
matches the URL runs, and a handler that throws is logged while the rest still run. They share the
add/remove and union-filter shape of the three answering events, and the Electron listener is
unregistered when the last handler leaves.

**Each registration returns a handle whose `remove()` takes that one handler back out.** Most
callers never need it (the verifier's partition stamp and the granted-origin CSP watch every
request for the process's whole life), so most ignore the return value; `dnr-webrequest.ts` is
the one that does not -- a person with no `declarativeNetRequest` extension loaded should not pay
for a webRequest round trip that always has nothing to do. `handler-while-needed.ts` is that
register-while-needed shape as a helper, used by the privacy controls
([`../privacy/install-privacy-net.ts`](../privacy/install-privacy-net.ts)) and the per-site script
and image blocks ([`../site-settings/install-content-settings.ts`](../site-settings/install-content-settings.ts)):
each calls `sync()` at start and from its settings listeners, so a setting turned on registers its
handler before the next request. `remove()` re-registers Electron's own
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
