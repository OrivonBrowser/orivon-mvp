# `src/main/sessions/`: what an Electron `Session` is allowed to do

**What lives here.** `permission-gate.ts` denies every Chromium permission (camera, clipboard
reads, geolocation, ...) on every session a tab can reach, except the names in the table below.
`external-links.ts` and `site-notifications.ts` decide the two that ask the person;
`notification-decisions.ts` remembers each site's notification answer; `tab-prompts.ts` is what
each tab remembers between questions. `web-context-host.ts` is `ADR-0019`'s Electron half of the
isolated `WebContext`: the real `WebContextHost`
[`../../broker/capabilities/web.ts`](../../broker/capabilities/web.ts) calls through
`CreateBrokerOptions.webContextHost`. `web-request-owner.ts` is the one place anything registers
Electron's own `onBeforeRequest`/`onBeforeSendHeaders`/`onHeadersReceived` on a session it
covers, composing every registered handler through `web-request-compose.ts`'s pure ordering
logic; see this file's Design notes below.

**What it depends on.** `electron`, [`../../contracts/`](../../contracts/) (`LIMITS`),
[`../../broker/`](../../broker/) (`grants/origin-hash.ts`, `grants/node-ledger-storage.ts`'s
`writeFileAtomic`, `policy/origin.ts`, `broker-contracts.ts` types),
[`../../loader/electron/serve.ts`](../../loader/electron/serve.ts),
[`../../protocols/builtin.ts`](../../protocols/builtin.ts), [`../shell/`](../shell/) (the two
questions, `external-link-prompt.ts` and `notification-prompt.ts`; `showing-window.ts`;
`exclusive-access-notice.ts`; `lock-navigation.ts`), the top-level `registry.ts`. Only
`permission-gate.ts`, `web-context-host.ts` and `web-request-owner.ts` import `electron`: the
decision files, `web-request-compose.ts` included, are unit-tested under plain vitest.

**What it must never import.** Nothing security-relevant about an isolated context may live in
[`../../broker/capabilities/web.ts`](../../broker/capabilities/web.ts) instead: that file stays
Electron-free by its own rule, which is why this directory exists. The partition, the view
construction and the network confinement have to live somewhere Electron-shaped, and this is it.

**Durable or tied to Electron.** `permission-gate.ts`, `web-context-host.ts` and
`web-request-owner.ts` are tied to Electron's `Session`; the decision files
(`web-request-compose.ts` included) and the notification store are plain Node and would survive
an engine change.

**Owner stream.** `shell` (`permission-gate.ts`); `ADR-0019` (`web-context-host.ts`).
Maintenance only.

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
subsystem.ts`) and the granted-origin CSP (`../install/granted-origin-csp.ts`). The embed session
([`../embed/embed-host.ts`](../embed/embed-host.ts)), the internal-pages session
([`../pages/internal-session.ts`](../pages/internal-session.ts)) and an isolated `WebContext`
session (`web-context-host.ts`, above) register directly instead: each is the only thing that
ever touches its own session's `webRequest`, so there is nothing there for an owner to arbitrate.

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
