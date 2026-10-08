# ADR-0070: An app's page shows its own files by URL

- **Status:** accepted, provisional
- **Date:** 2026-10-08
- **Type:** security
- **Decided by:** AI recommendation accepted by default; provisional until the owner confirms

## Decision
A page of an origin that holds a live `fs` grant may load its own files, read-only, as images and
media, at `/orivon/app/<path>` on its own origin: an `<img>`, a CSS image, an `<audio>` or a
`<video>` pointed at `/orivon/app/.config/x/poster.jpg` shows the file `orivon.fs` calls that path.
`/orivon/app` is the virtual root every Node-shaped path in an app already names (`process.cwd()`,
`os.homedir()`, `app.getPath('userData')`), so a path an app joins from those becomes a working URL
with no change to the app.

A `file:///orivon/app/<path>` address, which an Electron app builds as `'file://' + path`, is
rewritten to `/orivon/app/<path>` in the page where it is set: the `src` of `<audio>`, `<video>`,
`<img>` and `<source>`, `setAttribute('src', ...)` on them, and `new Audio(url)`. It is installed when
the `electron` shim loads. Any other `file:` URL is left alone and fails as it does in any web page.

The request is answered from the app's files only when all of these hold: the request is a GET or
HEAD for an image or media; its URL's origin is the origin of the page that made it (so another
site's `<img>` pointed at the URL gets what the app's host says, which is no oracle for a file's
existence or size); that origin holds an `fs` grant now; and the path then passes the confinement
`orivon.fs` applies (traversal, symlink and root rules, T1). The response carries a content type from
the extension, honours `Range`, and is `no-store` and `nosniff`. The app's CSP gains one scheme
source in `img-src` and `media-src` and nothing else.

## Context
An Electron app with `nodeIntegration` shows its own files by path, because its page is a `file:`
page. In two shapes: a root-absolute path used as a URL (`backgroundImage = "url('" + path + "')"`),
and a `file://` URL built from a path (`audio.src = 'file://' + path`). Here the first resolves to the
app's origin, whose host answers 404, and the second is refused by Chromium before a request leaves.
A ported torrent client shows no posters and plays no sounds. Rule 20 says the gap is closed in
Orivon, not in the port.

## How a request reaches the bytes
A session cannot answer an `http:` request of a granted loopback origin without taking over every
`http:` request of that session, which the shared session cannot afford. So a web-request handler
(on the default session and on each cache-served app's session) redirects the one verified request to
an `orivon-file:` URL, and a handler for that scheme on the same session streams the file from
`Broker.fs.open`. The redirect URL carries a MAC that only the main process can make, over the origin
and the path, and the handler serves nothing else: a page that asks for the scheme directly, or for
another app's file, gets 404. `Broker.fs.open` checks the grant and the confinement again at the
read, so a grant withdrawn after the redirect ends the response.

## Alternatives considered
- **`protocol.handle('http')` on the default session.** It answers `/orivon/app/` in-process, but it
  also routes every `http:` request of every tab through JavaScript. Rejected for the cost and the
  risk to ordinary browsing.
- **A data URL in the redirect.** No `Range`, and the whole file in the URL.
- **Rewriting URLs in the page for the root-absolute shape too.** CSS `url()` set by the app cannot
  be reached from a shim.
- **Answering from the app's host path unchanged.** The host is a static server the app does not
  control.

## Reasoning
`orivon.fs.readFile` already returns the same bytes to the same page. What this adds is the browser
displaying them, and the initiator check keeps every other origin out. The MAC makes the `orivon-file:`
scheme, which every session answers and any page can name, useless without a URL this process
issued. The redirect crosses origins, so an `<img crossorigin>` needs `access-control-allow-origin`
for the page's origin; the response sets it for exactly that origin.

## Consequences
- A path under `/orivon/app/` that the app's own host also serves is shadowed for images and media
  on a page that holds `fs`: the app's files win. The prefix is the shim's virtual root and nothing
  else uses it. A page with no `fs` grant keeps what its host serves there.
- Only `<img>`, CSS images, `<audio>`, `<video>` and `<source>` are served. `fetch`, `XMLHttpRequest`,
  fonts and a document navigation to the path still reach the app's host; use `orivon.fs`.
- A request with no frame (a dedicated worker's fetch) is not attributed and is left alone.
- Markup an app parses with `innerHTML` and CSS `url(file://...)` are not rewritten from `file:`.
- Every image and media request to a path that begins `/orivon/app/` passes through this process;
  the filter names only that prefix, so ordinary browsing is not routed here.

## Reversibility
- **Cost to reverse:** cheap. Remove the handlers, the scheme and the shim rewrite; an app that shows
  its files by URL goes back to broken images.
- **What would make us revisit:** the owner preferring that apps show files through `blob:` URLs
  they make themselves, or a case where a path under the prefix must reach the app's host.
