# ADR-0047: An app shows pages it serves itself, and hears a shown page's popups and downloads

- **Status:** accepted
- **Date:** 2026-09-30
- **Type:** security
- **Decided by:** owner, for keeping a protocol an app speaks inside the app rather than teaching
  it to the shell; AI recommendation for the pattern's grammar and the two events' shapes, which
  are provisional (`docs/open-questions.md` A305)

## Decision

`web.embed` (`ADR-0039`) changes in two ways, both in `src/contracts/`.

**A local pattern.** `EmbedCapability.origins` accepts a third kind of entry beside an exact
origin and `"*"`: `http://*.localhost:<port>` or `http://*.<name>.localhost:<port>`. It names
every origin with exactly one label where `*` stands, on that port. Its grammar is fixed: `http`
only, a port written out from 1024 up, `*` as the leftmost label and the only one, and `<name>`
one or more labels of lowercase letters, digits and hyphens.

A local pattern reaches only a listener the app itself holds on that port (`orivon.net.listen`,
from its page, a worker or a child). While the app holds none there, a page under the pattern does
not load. `"*"` may now be listed with other entries, each adding what `"*"` does not reach.

An app that speaks a protocol of its own serves each site from its own listener and shows it at
`http://<site>.localhost:<port>/`. The shell learns nothing about the protocol, and what the
app's own address bar reads is the app's business.

**Two events.** A page an app shows still opens no window and keeps no download, and the app now
hears of each. The `<webview>` element showing the page fires `orivon-popup` or `orivon-download`,
a `CustomEvent` that bubbles, whose `detail` is `EmbedPopup` (`url`, `disposition`, `frameName`,
`referrer`, `method`) or `EmbedDownload` (`url`, `filename`, `mimeType`, `totalBytes`);
`EmbedEventMap` names both for a typed listener. The window never opens, the transfer is
cancelled and no file is written; what happens next is the app's choice, made with its own
grants. An address longer than `LIMITS.embedEventUrlBytes` arrives as `''`.

## Context

The need named for Rule 4 is a ported Electron app that shows, beside ordinary websites, pages it
serves itself: a desktop client with a local gateway to content it fetches by its own means, the
shape Kubo's subdomain gateway (`<cid>.ipfs.localhost`) made familiar. In Electron such an app may
instead answer a URL scheme from its main process (`protocol.handle`). An app with a tab strip of
its own also turns a shown page's new window into a tab and lists its downloads.

Under `ADR-0039` alone it cannot be written:

- `"*"` must be the only entry and never reaches loopback, so an app cannot show any website and
  also a page it serves itself.
- An exact origin can name a loopback server, but only one origin at a time. Every site the app
  serves then shares one origin and one storage, and a site served under a path prefix breaks
  wherever it uses a root-relative address.
- A `target` link and a download do nothing, and the app hears nothing.

Measured in Electron 44, in a bare window outside the shell's own guarded views:
`http://<label>.<name>.localhost:<port>/` reaches a listener on `127.0.0.1` with no name lookup,
is a secure context with `crypto.subtle`, and each label is an origin of its own. A label of 63
characters loads; one of 64 fails to resolve. When a shown page navigates to a scheme Chromium
does not know, the element's own `will-navigate` event names the address.

Measured again once built, in the shell's own guarded view: a cookie a page under `*.localhost`
sets for `localhost` is rejected outright, and one set for `<name>.localhost` is read by every
label under it; a plain `target` link reports `frameName` `''`; and a shown page's navigation to
an unknown scheme made Chromium ask to open it outside the browser.

## Alternatives considered

1. **A request channel from the shell into the app for a scheme the manifest names**, the shape
   `ADR-0039` deferred. The page's own `location` would read `foo://`. It lost on three counts.
   Electron fixes a scheme's privileges before `ready`, so a scheme first granted while Orivon
   runs would have no origin, storage or `fetch` until a restart. `ADR-0038` refused a real scheme
   for the browser's own addresses for that reason. And it adds a request, response and body
   stream protocol to `orivon.*` for bytes the app can already serve over a socket it may already
   listen on.
2. **Serve the app's sites under `.orivon`, through the verifier, forwarding each request to the
   app.** Every piece exists (`ADR-0038`), but it is a TLS hop through a utility process and then
   a channel back into the app, for the same result the app's own listener gives.
3. **A subdomain wildcard under any domain** (`https://*.example.com`). No need names it, and
   such a name can resolve anywhere, so it would need the resolve-and-check rule `"*"` has. A
   `localhost` name is loopback by definition.
4. **Let `"*"` reach loopback.** T12 with a page around it, as `ADR-0039` reasons.
5. **Open the popup as a real page the app adopts**, keeping `window.opener`. The shell would have
   to create a shown page the app never attached and tie two pages across the app's own layout.
   No need names it, and the event leaves room for it.
6. **Hand a download's bytes to the app**, as a stream or a file in its directory. Additive later.
   An app can fetch the address itself, or read it inside the page through the element when the
   bytes need that page's cookies.
7. **Carry the two notices on the element's `ipc-message`, under reserved channel names.** It
   mixes the platform's messages with the app's own script's, and needs a rule about which names
   that script may use.
8. **A local pattern that reaches whatever holds the port.** Simpler to build, and wrong: if
   another program took the port first, its page would be shown inside the app, with the app's
   script running in it and the stored data of the site it stands in for. Tying the pattern to
   the app's own listener removes that case and makes the grant mean what its prompt says.
9. **An `https` form.** Nothing on this computer holds a certificate the browser trusts for a
   `localhost` name, so every page under it would fail. Chromium already treats an `http` page
   on a `localhost` name as a secure context.

## Reasoning

**The protocol stays in the app.** The app's code already runs under grants a person saw, and a
listener on loopback is one of them. Serving its sites there needs no new authority and no code
in the shell for a protocol only that app knows. The web platform then does the isolating: each
label is an origin, with storage and permissions keyed to it (cookies are the exception, below).

**The pattern adds less reach than an exact origin has.** An exact `localhost` origin was always
grantable, and reaches whichever program holds its port. The pattern names many origins at once
and reaches only the app's own listener, and the consent prompt says so in words.

**A shown page reaches outside itself only through the app.** That was `ADR-0039`'s rule for
`orivon.*` and grants; it now covers windows and downloads too, with the app told instead of
left guessing.

## Consequences

- **A shown page's own `location` is the `localhost` address.** Only the app's own surfaces show
  the address a person typed.
- **A site's name must fit one DNS label**: at most 63 characters of lowercase letters, digits
  and hyphens. An app re-encodes a longer or case-sensitive name.
- **An address on the app's own scheme inside a shown page does not load.** The element's
  `will-navigate` names a navigation to it, and the app loads its own address for it. A
  subresource on that scheme gets nothing. Such a navigation is never offered to another
  program and raises no prompt.
- **The listener is an ordinary `tcp.listen.local` one**, bound to `127.0.0.1` (`ADR-0034`).
  Other programs on this computer can reach it, so the app's server decides what it answers. A
  program bound to the same port on IPv6 loopback alone is an open residual
  (`docs/open-questions.md` A308).
- **A flood of notices is dropped.** Twenty in a second reach the app from one shown page; the
  contract does not state this bound yet (A305).
- **A popup address past the limit arrives as `about:blank#blocked`**, not `''`: Chromium
  replaces it before the shell sees it. The shell's own cap still holds for any other route.
- **Sites under one `<name>.localhost` are the same site to a cookie.** They are different
  origins, and a cookie one sets for `<name>.localhost` still reaches the rest. The bare
  `*.localhost` form keeps them apart, and is the one for sites that do not trust each other.
- **A download the grant does not admit as a document fires no event.** Under an exact origin, a
  link to a file on another origin is refused before it is known to be a download.
- **A form posted to a new window arrives as its address alone.** `method` says it was a post;
  the body is not carried.
- **`window.open` yields no window in a shown page.** A page that needs its opener, such as a
  sign-in popup that reports back, does not work there.
- **No byte of a cancelled download is kept.** A download from a `blob:` address, or one that
  needs the page's cookies, has to be read inside the page.
- **A contracts change**, so the usual cost: permanent once an app ships against it (`ADR-0002`).

## Reversibility

- **Cost to reverse:** cheap before the implementation lands; moderate after, since a manifest
  carrying a local pattern would stop loading.
- **What would make us revisit:** a protocol whose pages cannot work at an `http` origin; a name
  space that cannot be fitted to one label; or an app that needs the opened window itself, or a
  download's bytes, from the shell.
