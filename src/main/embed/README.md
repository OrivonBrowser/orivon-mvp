# `src/main/embed/`: the pages an app shows inside itself

**What lives here.** ADR-0039's Electron half. `embed-guard.ts`: the decisions, with no
`electron` import: what a `<webview>`'s preferences and attributes become whatever the app
wrote, which `persist:embed-` partition its pages live in, and whether a document request
inside a shown page may proceed under the app's live `web.embed` grant. `embed-host.ts`:
what Electron calls: `will-attach-webview` (refuse an app with no grant, rewrite the rest)
and `did-attach-webview` (register the guest with the broker so a revoke closes it, deny its
popups, forget it when it goes) on every `WebContents`, and each embed partition's session
(no downloads, every document request judged fresh). `embed-subsystem.ts`: registers the
host, and answers `EMBED_SCRIPT_CHANNEL`, the one thing a shown page's preload
(`src/preload/embed.ts`) asks: which script its app set with `orivon.web.setEmbedScript`. A document under a local pattern
(`http://*.localhost:<port>`, `ADR-0047`) loads only while `broker.embed.holdsListenerSync`
says the embedding app itself holds a listener on that port; the guard resolves no name for it.

**What it depends on.** `electron`; [`../../broker/`](../../broker/) (`broker-contracts.ts`
types, `policy/embed-origin.ts`'s document gate, `policy/address.ts`'s address classes, `policy/origin.ts`, `grants/origin-hash.ts`);
[`../dev/dev-mode.ts`](../dev/dev-mode.ts) (DevTools in a guest, developer mode only);
[`../../protocols/builtin.ts`](../../protocols/builtin.ts) (which hostnames route to the
verifier) and [`../verifier/partition.ts`](../verifier/partition.ts) (the same partition-stamp
rule the default session applies, reused rather than copied -- it imports nothing itself, so
this stays clear of `electron` and `src/loader/`); the top-level `channels.ts` and `registry.ts`.

**What it must never import.** [`../../renderer/`](../../renderer/) code (the repo-wide rule),
and nothing under [`../../loader/`](../../loader/): a shown page is another site's document,
never a pinned bundle, and nothing about serving one applies to it.

**Owner stream.** `shell`; ADR-0039.

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
load at once; a page already showing stays until it navigates. `*.localhost` is Chromium's own
loopback answer, so no lookup happens and nothing else on this computer can be reached by name
through the pattern.

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
