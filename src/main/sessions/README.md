# `src/main/sessions/`: what an Electron `Session` is allowed to do

**What lives here.** `permission-gate.ts`: denies every Chromium permission (camera, clipboard
reads, geolocation, …) on every session a tab can reach. Five pass without asking:
`clipboard-sanitized-write` (`ADR-0022`), `fullscreen` (`ADR-0025`), `pointerLock` and
`keyboardLock` (`ADR-0026`), and `fileSystem` for a single file the person chose, never a
directory (`ADR-0024`). Two pass only when the person says yes: `openExternal` (`ADR-0027`),
decided in `external-links.ts`, and `notifications` (`ADR-0028`), decided in
`site-notifications.ts` and remembered per site by `notification-decisions.ts`. `tab-prompts.ts` is what each tab remembers between those
questions. `web-context-host.ts`: ADR-0019's
Electron half of the isolated `WebContext` — the real `WebContextHost`
[`../../broker/web-capability.ts`](../../broker/web-capability.ts) calls through
`CreateBrokerOptions.webContextHost`: the partition, the sandboxed/isolated `WebContentsView`,
the reach-only network path, and the CORS wrapper.

**What it depends on.** `electron`, [`../../contracts/`](../../contracts/) (`LIMITS`),
[`../../broker/`](../../broker/) (`grants/origin-hash.ts`, `grants/node-ledger-storage.ts`'s
`writeFileAtomic`, `policy/origin.ts`, `broker-contracts.ts` types), [`../../loader/electron-serve.ts`](../../loader/electron-serve.ts),
[`../shell/`](../shell/) (the two questions, `external-link-prompt.ts` and
`notification-prompt.ts`; `showing-window.ts`; `exclusive-access-notice.ts`), the top-level
`registry.ts`. Only `permission-gate.ts` and `web-context-host.ts` import `electron`: the
decision files are unit-tested under plain vitest.

**What it must never import.** Nothing security-relevant about an isolated context may live in
[`../../broker/web-capability.ts`](../../broker/web-capability.ts) instead — that file stays
Electron-free by its own rule, which is exactly why this directory exists: the partition, the
view construction and the network confinement have to live somewhere Electron-shaped, and this
is it.

**Owner stream.** `shell` (`permission-gate.ts`, build step 1); ADR-0019
(`web-context-host.ts`). Maintenance only.

## Design notes

**[`permission-gate.ts`](permission-gate.ts): wired through `app.on('session-created', ...)`,
not a call inside [`../shell/tab-view.ts`](../shell/tab-view.ts)'s `makeTabView()`.** Electron
fires that event exactly once for every `Session` it ever instantiates in this process,
`session.defaultSession`'s own creation included, so one listener, attached before anything can
create a session, reaches every future `session.fromPartition(...)` call too, including ones no
code here has written yet. A handler installed only at `makeTabView`'s own call site would miss
the default session (used by the chrome UI and every rejected or dashboard-bound tab) and any
session a later stream creates some other way; enumerating today's known partitions once at
startup would still miss a partition a tab opens after that point, which is most of them:
`partitionFor(origin)` sessions come into being as tabs open, not at startup. The subsystem is
listed first in `subsystems.ts`, ahead of everything else, so its `beforeReady` attaches the
listener before any other subsystem's own `beforeReady` gets a chance to create a session.

**What the gate allows, and the rule a name must meet.** Seven permissions pass on every
ordinary session and every other one Chromium can ask for is refused. A name passes only on one
of two grounds:

1. **The platform gates it and the shell answers its abuse.** The web platform already gates it
   on an action by the person that the shell can neither fake nor suppress, and either (a) a
   legacy path already grants the same power, so refusing it would cost real pages without
   closing anything, or (b) the power's one abuse is answered by an affordance the shell itself
   draws, as every browser does.
2. **The person answers a real prompt.** The shell asks, in the window showing the page, naming
   the site that asks; nothing passes before the answer, and the check handler, which cannot
   ask, never allows on the person's behalf.

| Name | Ground | What meets it | ADR |
|---|---|---|---|
| `clipboard-sanitized-write` | 1(a) | Transient activation in a focused document; `document.execCommand('copy')` | `ADR-0022` |
| `fileSystem`, one file | 1(a) | The OS picker, a drop or a paste; `<input type="file">` and downloads | `ADR-0024` |
| `fullscreen` | 1(b) | A click; Escape in the browser process; "Press Esc to exit full screen" | `ADR-0025` |
| `pointerLock` | 1(b) | A click; Escape in the browser process; "Press Esc to show your cursor" | `ADR-0026` |
| `keyboardLock` | 1(b) | Acts only in fullscreen, which a click enters; holding Escape leaves; "Press and hold Esc to exit full screen" | `ADR-0026` |
| `openExternal` | 2 | "Open *scheme* link with your system's default app?", every time | `ADR-0027` |
| `notifications` | 2 | "*site* wants to show notifications", once per site, remembered | `ADR-0028` |

`clipboard-sanitized-write` is granted outright. The web
platform gates clipboard writing on transient user activation and a focused document, so the
page cannot reach the clipboard unless the person just acted in it, and Chromium sanitizes what
lands there. Refusing it protected nothing, because `document.execCommand('copy')` reaches the
same clipboard from the same pages and no Electron API can close that path -- and this gate
covers the default session, so the refusal broke copy buttons on ordinary websites, not only in
apps. Reading stays denied in both forms. `ADR-0022` carries the argument in full.

`fileSystem` is granted for one file, to read or to write, and refused for a directory. A page
cannot name a path: it holds a handle to a file on disk only because the person picked it in an
OS dialog, or dropped or pasted it. `<input type="file">` and a download already reach a file the
person picks. A directory handle would reach every file beneath it, and a child's handle needs
the directory's read grant first, so refusing directories closes the whole tree. `ADR-0024`
carries the argument, including the two cases where this allows without asking what Chrome
would ask about first.

**Electron decides File System Access through the CHECK handler alone.** Measured against a real
page: `getFile()`, `createWritable()`, `queryPermission()`, `requestPermission()` and listing a
directory each reach `setPermissionCheckHandler` with `filePath`, `isDirectory` and
`fileAccessType` in its details, and never reach the request handler. The request handler applies
the same predicate anyway, so that routing a call through it in a later Electron cannot open what
the check handler refuses. Because that handler is synchronous, the gate can say yes or no but
cannot ask the person, which is why the rule rests on the person's choice of file, not on a
prompt.

`fullscreen` meets ground 1(b). Chromium lets a
page enter fullscreen only from a click in it, and it asks this gate on the request handler only:
measured against a real page, `requestFullscreen()` reaches `setPermissionRequestHandler` with
`fullscreen` and `setPermissionCheckHandler` with `automatic-fullscreen`, the content setting
that waives the click. The second stays denied, so the click is always required. Leaving is not
the page's to refuse: Escape is consumed in the browser process before the page sees the key.
The one abuse, a page filling the screen and drawing a fake address bar, is answered by the exit
notice every browser shows; [`../shell/fullscreen-notice.ts`](../shell/fullscreen-notice.ts)
draws it. `ADR-0025` carries the argument.

**`pointerLock` and `keyboardLock` reach the REQUEST handler only, and Electron draws nothing
for either.** Measured against a real page: `requestPointerLock()` reaches
`setPermissionRequestHandler` as `pointerLock`, `navigator.keyboard.lock()` as `keyboardLock`, and
neither reaches the check handler. Chromium refuses pointer lock without a click even when the
gate says yes, and Escape releases it before the page sees the key. Keyboard lock needs no click,
but Chromium applies it only in fullscreen, and asks for it again each time the page enters
fullscreen; there a page holding Escape receives a single press, and holding the key for about
two seconds still leaves. Neither shows any bubble of Chromium's own in Electron, so
[`../shell/exclusive-access-notice.ts`](../shell/exclusive-access-notice.ts) shows the notice,
and it learns a tab is in fullscreen from the tab's own enter and leave events, watched from the
`fullscreen` grant onward: the gate notes a grant before answering it for exactly that reason.

**`openExternal`: answering yes IS the launch.** Measured: once the request handler grants it,
Electron itself hands the URL to the OS's handler for the scheme (`xdg-open` on Linux), so the
gate never calls `shell.openExternal` and nothing launches but the URL the person was shown. The
same measurement found that the request arrives whether or not the page was clicked, so a page
could loop the question; [`external-links.ts`](external-links.ts) asks once, then waits for the
person to click or type in the page before asking that tab again, which is Chrome's own rule. It
refuses without asking for the browser's own schemes, for `file:`, `data:`, `blob:` and
`javascript:`, for any scheme starting `orivon`, and for Chrome's list of OS handlers that must
never be launched from a page. A tab that is not on screen is never asked for: the question
would appear over a page it did not come from.

**`notifications`: Electron's check handler can only say yes or no.** `Notification.permission`
and the Permissions API read `granted` for a site the person allowed and `denied` for every
other, including a site nobody has asked about yet: Electron has no way to report "not decided".
A page that calls `Notification.requestPermission()` still reaches the request handler, which
asks; Electron documents that "most web APIs do a permission check and then make a permission
request if the check is denied". A page that reads `Notification.permission` first and gives up
on `denied` never asks. *Provisional:* neither half has been measured against a real page here,
because no test may run notification code until the headless runner isolates the session bus
(`test/e2e-site-permissions.test.ts` has the checks, and refuses to run them before that).
Dismissing the question ("Not now", Escape, closing it) decides nothing and remembers nothing;
that page load is not asked again. A frame is never asked for, and only a frame of the page's own
site gets the page's remembered answer. [`notification-decisions.ts`](notification-decisions.ts)
keeps the answers in `<userData>/notification-decisions.json`, read once into memory because the
check handler is synchronous.

Two consequences worth knowing before touching either file. `web-context-host.ts` reinstalls
deny-everything handlers on `ADR-0019` isolated-context sessions, and that is now the only thing
holding clipboard write, fullscreen, pointer and keyboard lock, file access, external links and
notifications away from a document running another site's script -- it looks like duplication
and is not. And the grant ledger is untouched by any of this: it governs `orivon.*`
capabilities, not Chromium's own, so no app gained a power a plain website does not have.

**[`web-context-host.ts`](web-context-host.ts)'s two WebRTC belts, and why a proxy pointed at the
discard port does not also break the context's own `fetch()`.** ADR-0019 promises an isolated
context "no network of its own"; `protocol.handle('https'/'http', ...)` and
`webRequest.onBeforeRequest` (cancelling `ws:`/`wss:`) cover everything that passes through
Electron's own protocol/request layer, but WebRTC's ICE/STUN/TURN dial does not -- it is Chromium's
network service talking raw UDP/TCP, a gap `docs/open-questions.md` A41 already names as
unsolved and platform-wide for app tabs generally. A context has no legitimate reason to use
WebRTC at all, so rather than trying to scope a partial allowance the way A41's own open item
frames the harder app-tab problem, it is closed outright, with two independent belts so that a
single missed path does not silently reopen it:

- `webContents.setWebRTCIPHandlingPolicy('disable_non_proxied_udp')` forces WebRTC to route
  through a proxy or not run at all.
- `session.setProxy({ mode: 'fixed_servers', proxyRules: 'http://127.0.0.1:9' })` on the
  partition, pointed at the loopback discard port (RFC 863) -- nothing answers there, so whatever
  that policy hands to a proxy dies on arrival, and so does anything else this session's own
  network stack might dial outside the two handlers above.

**Why the proxy does not intercept the context's own `fetch()` to a granted origin.** Proven
against the real shell, not assumed: `test/e2e-web-context-network.test.ts` fetches
`https://example.com` through a context with both belts active and still gets a real response.
This holds because `protocol.handle` REPLACES Chromium's network stack for the scheme it
registers -- a request answered by a custom protocol handler never reaches the proxy-resolution
step at all, the same reason [`../../loader/serve.ts`](../../loader/serve.ts)'s own app-origin
handler never needed proxy awareness. The proxy only ever sees a connection attempt that
`protocol.handle` did NOT intercept, which for `https:`/`http:` from inside a context should
never happen -- so the discard-port proxy is a belt for exactly the gap outside those two
schemes, not a second gate in front of them.

Verified against Electron 44's own `electron.d.ts`, not assumed: both APIs are documented there
with these exact shapes (`WebContents.setWebRTCIPHandlingPolicy`, `Session.setProxy` taking a
`ProxyConfig` with `mode`/`proxyRules`).
