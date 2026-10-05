# `src/main/media-grants/`: a registered app's camera, microphone and screen

**What lives here.** The app door of `media.camera`, `media.microphone` and `media.screen`
([ADR-0032](../../../docs/decisions/ADR-0032-camera-microphone-and-clipboard-read-join-the-grant-model.md),
[ADR-0055](../../../docs/decisions/ADR-0055-a-page-shares-a-screen-only-through-orivon-s-picker-and-only-by-a-call-orivon-makes.md)):
a grant in the ledger, offered at install consent with the app's other capabilities, asked at run time when the
manifest declares the kind and none is held, and revocable in Settings like any other.

| File | Job |
|---|---|
| `app-media-grants.ts` | Pure: `AppMediaGrants`, the interface the display gate reads. `held` reads the ledger; `request` asks once per page load for a declared kind that is not held |
| `app-media-asker.ts` | Pure: the `SiteAsker` that answers `media` for a registered app's top frame: a device request asks for its kinds, a device check reads `held`, and everything else is `undefined` |
| `install-media-grants.ts` | The installer: builds the grants over the broker and the request-grant flow, binds them where the display gate finds them, and adds the asker to the registry |

**What it depends on.** `electron` (types), [`../display-capture/`](../display-capture/) (the shapes and the
binding), [`../sessions/site-asks.ts`](../sessions/site-asks.ts) (the registry), [`../shell/`](../shell/)
(`ShellInstaller`, `ShellServices`), [`../site-settings/app-origin.ts`](../site-settings/app-origin.ts) and
[`../consent/request-grant.ts`](../consent/request-grant.ts) (the `DialogCaller` type only: the question itself
arrives through the context's `requestGrant`).

**What it must never import.** The display gate's files beyond `types.ts` and `bindings.ts`, and [`../consent/`](../consent/) at run time: the
question and its dialog stay the request-grant flow's, so an app's media is asked in the same words and the same
panel as its other grants.

**Owner stream.** `shell`.

**Electron dependence.** The installer is tied to Electron; the grants and the asker import no `electron` at
runtime and are unit-tested with fakes.

## Design notes

**Why a new directory.** `display-capture/` may not import `consent/`, so its binding is filled by an installer that
may. This directory is that installer and what it builds, so the app door is one place whether the request comes
from a device request or a display request.

**The asker is registered ahead of the per-site asker.** The registry answers with the first asker whose answer is
not `undefined`, in registration order, and the per-site asker refuses every app origin. `shell-installers.ts` keeps
`media-grants` before `site-permissions`, and its test pins the order. An asker that is not an app's falls through:
a website, an embed, a request with no device type and every other permission.

**A registered app, not an app that holds a grant.** The asker's test for an app is "holds a grant or is served from
the cache, or has a manifest registered". An app whose person declined everything at install holds no grant, and
must not turn into a website that is asked per site.

**A no is remembered per page load.** The request-grant flow does not record a deny, so a page calling
`getUserMedia` in a loop would raise a question each time. The grants remember a refusal for the kind on the page
the tab shows and forget it on the next document. A grant the person gives later, in the site-info popover, is read
first, so it needs no reload.

**Revoking records a decline** (`permissions.ts`), so after Revoke the next request is refused without a question,
until the person switches it on again in the popover.
