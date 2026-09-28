# ADR-0039: An app may show a site inside its own page

- **Status:** accepted
- **Date:** 2026-09-28
- **Type:** security
- **Decided by:** owner (the feature); AI recommendation for its shape, with the provisional
  points listed under Consequences awaiting the owner

## Decision

Orivon gains one capability kind, `web.embed`, declared as `capabilities.web.embed.origins` in
the manifest (`src/contracts/manifest.ts`, `EmbedCapability`). An app holding it may put a
`<webview>` element in its page: a browser view inside its own layout, showing a site of its
choosing, with the element's interface as Electron defines it. The app controls the view the way
an Electron app does (`src`, `loadURL`, `executeJavaScript`, `insertCSS`, `findInPage`, `send`
and `ipc-message`, muting), and one call of its own, `orivon.web.setEmbedScript(source)`, sets
a script that runs first in every page it shows, before that page's own code, with a bridge back
to the element.

The patterns are exact `http(s)://host[:port]` origins, or the single entry `"*"` for any site
on the web. A page the app shows may load a document, in its top frame or a frame inside it, only
from the granted origins. `"*"` never reaches an address literal outside public unicast or a
`localhost` name (T12); an origin named exactly may be one, and the person sees that address at
consent.

Every page an app shows runs:

- **in a storage partition of the app's own**, `persist:`, kept across restarts, apart from the
  person's ordinary browsing and from the app's own partition, so a site the app shows can keep
  the person signed in without the app's own storage or the browser's ever being reachable from
  it;
- **sandboxed and isolated, with the shell's own preload and never the app's.** The shell
  rewrites what the element asks for at attach time: its `preload`, `partition`,
  `nodeintegration`, `disablewebsecurity` and `webpreferences` attributes are replaced, not
  honoured. The page has no `orivon.*`, no path to the app's grants, no `<webview>` of its own,
  no popups and no downloads;
- **as one of at most `LIMITS.embeds` pages per app**, each a renderer process of its own.

The consent prompt carries a warning and says what the grant gives: *"Show any website inside
itself, and read and change what those pages show"*, or the origins named. It is one grant,
separately revocable, and an app declaring `per-capability` consent keeps working without it.

## Context

Electron desktop apps commonly show other sites inside their own window: a feed reader's
article pane, a documentation browser, a client that signs the person into a service in place, a
wallet that opens a dapp beside its own controls. Electron's `<webview>` is how they do it. Ported
to Orivon, each meets an element the shell keeps switched off: `webviewTag` defaults to false and
nothing in `src/` turned it on, so the element is inert HTML and the app's main surface is blank.
The need named for Rule 4 is a ported app whose main surface is such a view.

An `<iframe>` does not serve: a cross-origin site refuses framing (`X-Frame-Options`,
`frame-ancestors`), and even one that allows it gives the app no `executeJavaScript`, no
`findInPage`, no way to read the page. `web.context` (ADR-0019) is the wrong tool for a different
reason: a context is never displayed, and it runs the app's code *as* the site rather than
showing the site to the person.

## Alternatives considered

1. **A stand-in element plus a shell-drawn `WebContentsView` laid over the page area.** More
   code, and worse: a separate view always draws on top of the page, so every menu, dialog or
   dropdown the app draws over that area vanishes behind it. Electron's own `<webview>` is drawn
   inside the page, and the app's UI stacks over it as it does in Electron. Lost on that.
2. **Turn the element on with no grant, as Electron does.** Rejected: an app that can show any
   site and run code in it can see and change everything the person does there, which is exactly
   the class of power the grant model exists to name. Design rule 5, no capability is implicit.
3. **Two kinds, one for showing and one for changing.** Considered and rejected. The element's
   own interface already lets an app read a page (`getTitle`, `getURL`, `findInPage`,
   `capturePage`) and change it (`executeJavaScript`, `insertCSS`), and the shell cannot deny
   those per call: they travel Electron's own guest channel, not the broker's. A "show only"
   grant would promise a limit the platform cannot keep. One grant, honestly worded, instead.
4. **Let the app's page script reach every frame, not only the top one.** Rejected for this
   build: a preload in subframes needs `nodeIntegrationInSubFrames`, which the shell refuses on
   every renderer. A frame inside a shown page runs that page's own code, untouched by the app.
5. **Custom URL schemes answered by the app for the pages it shows.** Not in this ADR. An app
   that wants to answer `foo://` inside its shown pages needs a request channel from the shell
   back into the app, a shape nothing in `orivon.*` has yet. Deferred until a need names it
   (`docs/planning/compatibility-matrix.md`).

## Reasoning

**What the capability adds, exactly.** An app already holding `https.connect` can fetch any
granted site's bytes and read them (ADR-0017). What it cannot do is *show* a site to the person
as a live page, with that site's own code running and the person acting in it. That page, and
the app's hand in it, is the whole delta.

**Why the page runs apart from everything else.** The person is acting in a real site, possibly
signed in. Its partition must not be the app's own, or the app's grants and cache handler would
apply inside a page the app did not write; and it must not be the shared default session, or a
site shown inside an app would see the person's ordinary cookies. A partition per app is the one
placement where neither leak is possible.

**Why the shell rewrites the element's attributes rather than refusing bad ones.** Electron's own
warning on `webviewTag` is that a page can name a `preload` with Node integration. Refusing at
attach time would destroy the guest with no event the app can act on; rewriting keeps every
attach working and makes the security properties hold whatever the app wrote.

**Why `"*"` stops at private addresses.** A page shown inside an app is reached by Chromium's
own network stack, at a URL the app chose, with the app's script inside it. `"*"` reaching a
router's admin page or a service on loopback is the T12 threat with a page around it. The rule
mirrors `tcp.connect`: a wildcard reaches public addresses only, and an address the person was
shown reaches what it names.

## Consequences

- **A person granting `web.embed` is trusting the app the way they trust a browser.** The prompt
  says so, with a warning at every level but 4 (ADR-0037).
- **The element's interface is Electron's.** This is the one contract that names an element
  rather than an `orivon.*` call. It is older than this project (Chrome Apps defined it), and
  ADR-0002's promise binds any engine beneath Orivon to keep it working for apps written
  against it.
- **A shown page's top frame gets the app's script; its subframes do not.** Stated in the
  contract.
- **Popups and downloads from a shown page do nothing, and the app hears nothing.** A `target`
  link opens nowhere. A later change may hand both to the app; nothing here forbids it.
- **`LIMITS.embeds` (32) and the T12 rule for `"*"` are provisional**, AI-chosen
  (`docs/open-questions.md` A261). The owner's confirmation settles them.
- **A contracts change**, so the usual cost: permanent once an app ships against it (ADR-0002).

## Reversibility

- **Cost to reverse:** cheap before the implementation lands; expensive once any app depends on
  the element being live.
- **What would make us revisit:** an engine beneath Orivon that cannot draw a guest inside a
  page; a demonstrated escape from a shown page into the app's partition or grants; or the
  prompt's wording proving, with users, to understate what an app can do with the page.
