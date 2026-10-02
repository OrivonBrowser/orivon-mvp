# `src/main/embed/`: the pages an app shows inside itself

**What lives here.** ADR-0039's Electron half. `embed-guard.ts`: the decisions, with no
`electron` import: what a `<webview>`'s preferences and attributes become whatever the app
wrote, which `persist:embed-` partition its pages live in, and whether a document request
inside a shown page may proceed under the app's live `web.embed` grant. `embed-events.ts`: what
the app is told of a window a shown page asked for and a download it started (ADR-0047), built
from what Electron reports, with no `electron` import. `embed-host.ts`:
what Electron calls: `will-attach-webview` (refuse an app with no grant, rewrite the rest)
and `did-attach-webview` (register the guest with the broker so a revoke closes it, deny its
popups and tell the app of each, forget it when it goes) on every `WebContents`, and each embed
partition's session (every download cancelled and told to the app, every document request judged
fresh). `embed-subsystem.ts`: registers the
host, and answers `EMBED_SCRIPT_CHANNEL`, the one thing a shown page's preload
(`src/preload/embed.ts`) asks: which script its app set with `orivon.web.setEmbedScript`. A document under a local pattern
(`http://*.localhost:<port>`, `ADR-0047`) loads only while `broker.embed.holdsListenerSync`
says the embedding app itself holds a listener on that port; the guard resolves no name for it.

**What it depends on.** `electron`; [`../../broker/`](../../broker/) (`broker-contracts.ts`
types, `policy/embed-origin.ts`'s document gate, `policy/address.ts`'s address classes, `policy/origin.ts`, `grants/origin-hash.ts`);
[`../dev/dev-mode.ts`](../dev/dev-mode.ts) (DevTools in a guest, developer mode only);
[`../shell/page-dialogs.ts`](../shell/page-dialogs.ts) (a shown page's `alert`, `confirm` and `prompt`, asked in the app's own tab with the shown page's origin, from Electron's own dialog event on the guest);
[`../../protocols/builtin.ts`](../../protocols/builtin.ts) (which hostnames route to the
verifier) and [`../verifier/partition.ts`](../verifier/partition.ts) (the same partition-stamp
rule the default session applies, reused rather than copied -- it imports nothing itself, so
this stays clear of `electron` and `src/loader/`); the top-level `channels.ts` and `registry.ts`.

**What it must never import.** [`../../renderer/`](../../renderer/) code (the repo-wide rule),
and nothing under [`../../loader/`](../../loader/): a shown page is another site's document,
never a pinned bundle, and nothing about serving one applies to it.

**Owner stream.** `shell`; ADR-0039, ADR-0047.

## Design notes

**`did-attach-webview` learns which app a guest belongs to from the guest's own `session`, not
from re-reading the embedder's top frame.** `will-attach-webview` picks the guest's partition
through `partitionReady(appOrigin)`, which records `appOrigin` against that partition's `Session`
object the first time it configures it. `did-attach-webview` gets no origin of its own, only the
new guest `WebContents`; it looks `guest.session` up in that same map. This works only because
Electron hands back the SAME `Session` object from `session.fromPartition(partition)` and from
the attached guest's own `webContents.session` -- proven, not assumed, by
[`../../../test/e2e-embed.test.ts`](../../../test/e2e-embed.test.ts)'s `inEmbedPartition` check,
which is also this design's regression guard. Keying on the guest's session rather than queuing
origins per embedder needs no ordering assumption at all: two `<webview>`s attaching on the same
or different tabs, in any order or interleaving, each resolve to the app whose grant configured
the partition they actually ended up in.

**Attached through `app.on('web-contents-created')`, not in `tab-view.ts`'s per-view wiring.**
The same reason [`../sessions/permission-gate.ts`](../sessions/permission-gate.ts) attaches
through `session-created`: the event reaches every `WebContents` this process ever makes, so a
popup adopted as a tab, or a view a later stream builds, is covered without remembering to
wire it. `webviewTag` itself is switched on only for a registered app's tab
([`../shell/tab-view.ts`](../shell/tab-view.ts)), and even there every attach is decided here
against the live grant, so the switch grants nothing by itself.

**Rewritten, not refused.** Electron's own warning on `webviewTag` is that a page can name a
`preload` with Node integration. `hardenGuest` replaces the guest's `preload`, `partition` and
every security-relevant preference rather than checking and refusing them: refusing at attach
would destroy the guest with no event the app can act on, while rewriting keeps every attach
working with the properties holding whatever the app wrote. The one refusal, an app with no
`web.embed` grant at all, gets `preventDefault`, since there is nothing to rewrite towards.

**A refused document load never commits, and the app sees it as a rejected `loadURL()`.** The
embed session's `onBeforeRequest` cancels a top-frame or subframe document request outside the
grant, and Chromium reports it to the guest as a failed navigation that never leaves the page
it was showing. Electron's `<webview>` fires no `did-fail-load` for that case, measured in
Electron 44; the element's `loadURL()` promise rejects instead, and
[`../../../test/e2e-embed.test.ts`](../../../test/e2e-embed.test.ts) asserts exactly that. A
`file:` URL is refused the same way: `onBeforeRequest` sees it, so no second gate is needed.

**A local pattern is asked of the broker, with the app origin the partition was configured for.**
`guestRequestAllowed` takes the question as a function (`listenerHeld`) and refuses when it is
absent or throws, so a caller that forgets to wire it shows no local page rather than every one.
The answer is read on every document load, so an app that closes its listener stops the next
load at once. A page already showing would keep same-origin access to whatever binds the port
next, so when the broker reports the app's last listener on a port closed
(`broker.embed.onListenerClosed`), the host closes every guest of that app showing a local-pattern
document on that port, in its top frame or any frame inside it (`showsLocalPageOn`), the way a
revoked grant closes it. Every `.localhost` name is mapped to IPv4 loopback by the process-wide
resolver rules (`../verifier/resolver-rules.ts`), the address the app's listener binds, so a server
on `[::1]` cannot answer for it; no lookup happens, and nothing else on this computer can be
reached by name through the pattern.

**The script's identity comes from the sender, never the request.** `EMBED_SCRIPT_CHANNEL` is
synchronous so the script runs before the page's own code, and its reply is decided from
`event.sender` alone: a webview guest the host adopted, whose app still holds the grant. A
compromised guest renderer asking on that channel learns only the script it was going to run
anyway.

**Why the guest registers with the broker as a handle.** `broker.embed.attach` files each shown
page under the grant in the same `HandleTable` a socket or an isolated context lives in, so
`HandleTable.revoke`'s ordinary cascade closes it when the grant is withdrawn or narrowed. There
is no second revocation mechanism to keep in step, and `LIMITS.embeds` is enforced where every
other per-origin cap is.

**A popup and a download reach the app as an event on its `<webview>`, sent from here and
dispatched by the app page's preload.** `embed-host.ts` keeps `action: 'deny'` for every window and
cancels every download after reading the item, then sends the embedder's main frame
`EMBED_EVENT_CHANNEL` with the guest's id, the event name and the detail `embed-events.ts` built.
[`../../preload/embed-event-relay.ts`](../../preload/embed-event-relay.ts) finds the `<webview>`
whose `getWebContentsId()` matches and dispatches the event in the main world; an id no element
matches is dropped. A notice is sent only while that main frame is still on the app origin that
owns the guest; a page that committed another origin hears nothing. The embedder is recorded at `did-attach-webview`, and forgotten with the guest.
Every field a shown page chooses is bounded: an address (`url`, `referrer`) past
`LIMITS.embedEventUrlBytes`, and a `frameName`, `filename` or `mimeType` past `NOTICE_TEXT_BYTES`
(4096 UTF-8 bytes), each arrives as `''`.

**A shown page cannot flood its app with notices.** The page chooses when it asks for a window,
and each notice may carry an address up to `LIMITS.embedEventUrlBytes`. Each guest gets a budget
(`createNoticeBudget`): `NOTICES_PER_SECOND` notices in a second reach the app and the rest are
dropped. The window is denied and the download cancelled either way.

**`disablePopups` is turned off on every guest, and the window-open handler is set the moment
the guest exists.** Chromium reports no popup at all while the guest's `disablePopups` is true,
and Electron derives it from the element's own `allowpopups` attribute, which an app need not
have written and `will-attach-webview`'s `params` can no longer change. `hardenGuest` sets it
false on `webPreferences`; `installEmbedHost` denies every window from `web-contents-created`, so
none is open to Electron's default (allow) in the moment before `did-attach-webview` installs the
handler that tells the app.

**A shown page's navigation to a scheme Chromium does not know is heard by the element and
offered to nothing.** The element's `will-navigate` names the address. Chromium also asks the
session for `openExternal`, and `../sessions/permission-gate.ts` refuses it for a `webview`
without asking the person: a shown page reaches another program only through its app.

**Chromium bounds an address before the shell sees it.** A `window.open` past 2 MiB reaches the
shell as `about:blank#blocked`, so `LIMITS.embedEventUrlBytes` (the same size) is a bound the
shell keeps whatever Chromium does, and an address reaches the app whole up to it.
