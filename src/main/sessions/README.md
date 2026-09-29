# `src/main/sessions/`: what an Electron `Session` is allowed to do

**What lives here.** `permission-gate.ts` denies every Chromium permission (camera, clipboard
reads, geolocation, ...) on every session a tab can reach, except the names in the table below.
`external-links.ts` and `site-notifications.ts` decide the two that ask the person;
`notification-decisions.ts` remembers each site's notification answer; `tab-prompts.ts` is what
each tab remembers between questions. `web-context-host.ts` is `ADR-0019`'s Electron half of the
isolated `WebContext`: the real `WebContextHost`
[`../../broker/capabilities/web.ts`](../../broker/capabilities/web.ts) calls through
`CreateBrokerOptions.webContextHost`. `session-attribution.ts` publishes `ctx.senderAttributed`
(`../registry.ts`): whether a WebContents is attributed to the origin it claims, decided at that
document's own commit and reused afterward rather than re-decided live, reusing
[`../shell/tab-view.ts`](../shell/tab-view.ts)'s own `partitionForTarget` rule so every
renderer-reachable broker channel can refuse a call whose WebContents never committed the origin
it claims in the session it belongs in.

**What it depends on.** `electron`, [`../../contracts/`](../../contracts/) (`LIMITS`),
[`../../broker/`](../../broker/) (`grants/origin-hash.ts`, `grants/node-ledger-storage.ts`'s
`writeFileAtomic`, `policy/origin.ts`, `broker-contracts.ts` types),
[`../../loader/electron/serve.ts`](../../loader/electron/serve.ts),
[`../../protocols/builtin.ts`](../../protocols/builtin.ts), [`../shell/`](../shell/) (the two
questions, `external-link-prompt.ts` and `notification-prompt.ts`; `showing-window.ts`;
`exclusive-access-notice.ts`; `lock-navigation.ts`; `tab-view.ts`'s `partitionForTarget`), the
top-level `registry.ts`. `permission-gate.ts`, `web-context-host.ts` and `session-attribution.ts`
import `electron`; the decision files are unit-tested under plain vitest.

**What it must never import.** Nothing security-relevant about an isolated context may live in
[`../../broker/capabilities/web.ts`](../../broker/capabilities/web.ts) instead: that file stays
Electron-free by its own rule, which is why this directory exists. The partition, the view
construction and the network confinement have to live somewhere Electron-shaped, and this is it.

**Durable or tied to Electron.** `permission-gate.ts`, `web-context-host.ts` and
`session-attribution.ts` are tied to Electron's `Session`; the decision files and the
notification store are plain Node and would survive an engine change.

**Owner stream.** `shell` (`permission-gate.ts`, `session-attribution.ts`); `ADR-0019`
(`web-context-host.ts`). Maintenance only.

## Design notes

**[`permission-gate.ts`](permission-gate.ts): wired through `app.on('session-created', ...)`,
not at any one session's construction site.** Electron fires that event once for every `Session`
it instantiates, `session.defaultSession` included, so one listener reaches partitions no code
has created yet; most `partitionFor(origin)` sessions come into being as tabs open. A handler in
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

**[`session-attribution.ts`](session-attribution.ts) decides attribution at a document's own
commit, never by re-checking a live document against the CURRENT ledger.** A live re-check
sounds simpler, and was the original rule, but it strands every already-open, already-attributed
document of an origin the instant a grant or a revoke changes which session that origin belongs
in next: a tab whose app just lost its last grant is denied even `app.requestGrant` to ask again,
and a second tab of an app already granted is denied the moment the first one's grant lands,
because neither tab's `WebContents` ever moves on its own. Recording what a document's session
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
