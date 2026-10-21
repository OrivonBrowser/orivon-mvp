# `src/main/scheme-routing/`: a link opens in the app the person chooses

**What lives here.** The part of [ADR-0072](../../../docs/decisions/ADR-0072-a-link-scheme-an-app-declares-opens-in-the-app-the-person-chooses.md):
a link of a scheme an app lists in its manifest's `protocols` (`magnet:`) goes to that app's page.

| File | Job |
|---|---|
| `app-directory.ts` | Which apps may take a scheme: loaded this session, holding a grant, listing the scheme |
| `scheme-choices.ts` | The app chosen for each scheme, in `scheme-handlers.json` under the profile (memory only in a private session) |
| `open-url-queue.ts` | The links not yet taken by an app's page: held up to 16 and two minutes, handed to the page that waits |
| `scheme-routing.ts` | What the external-link gate calls (`LinkRouting`) and what the control channel reaches (`SchemeHost`): choose, remember, queue, `requestSchemeHandler`, `isSchemeHandler` |
| `show-app.ts` | Shows the tab already on the app, else opens one in the window the link came from |
| `grant-watch.ts` | Ending an app's last grant forgets the schemes it was the default for |
| `install-scheme-routing.ts` | Wires all of the above to the running shell and publishes `ctx.schemeHost` |

**What it depends on.** [`../sessions/external-links.ts`](../sessions/external-links.ts) (the gate's types and the scheme rules),
[`../shell/`](../shell/) (`WindowRegistry`, the questions, `ShellServices`), [`../../broker/`](../../broker/) (types and the
atomic file write), [`../registry.ts`](../registry.ts) (`publishSchemeHost`).

**What it must never import.** [`../shell/tabs.ts`](../shell/tabs.ts) or [`../shell/tab-view.ts`](../shell/tab-view.ts).

**Owner stream.** `shell`.

**Electron dependence.** Only `install-scheme-routing.ts` is tied to Electron (through the types it is given); every other file imports
no `electron` and is unit tested with fakes.

## Design notes

**A page has no push channel, so it waits.** `orivon.app.onOpenUrl` starts a long poll of `app.nextOpenUrl`
([`../../preload/surface/open-url.ts`](../../preload/surface/open-url.ts)); the shell answers null after 25 s and the page asks
again. A wait ends, answering null, when its tab starts a new page or is destroyed, so a link is never handed to a document that is
gone; the queue keeps it for the next page.

**The grant is checked at the moment of delivery, not only when the question was drawn.** The person decided against a list read
earlier, and an app can lose its grant meanwhile.

**The question offers two apps at most**, because the panel's row holds four buttons. *Provisional*: see the ADR.
