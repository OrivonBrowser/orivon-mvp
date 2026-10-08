# ADR-0072: A link scheme an app declares opens in the app the person chooses

- **Status:** accepted
- **Date:** 2026-10-08
- **Type:** security
- **Decided by:** owner (the behaviour, d-0596); AI recommendation for the shape, *provisional* where marked

## Decision
A link of a scheme that an installed or granted app lists in its manifest's `protocols` (first `magnet:`) can open in
that app. The person chooses, and the app's page receives the URL.

**Who may handle a scheme.** An app the broker has loaded, that holds a grant now, and whose manifest lists the scheme.
Never `http`, `https`, `file`, `javascript`, an `orivon*` scheme, a protocol's own address scheme or anything the
external-link gate refuses (ADR-0027); a `magnet:` link keeps its BitTorrent grammar, and no link is longer than 4096
characters. An app that lists a scheme with no grant is not offered.

**How the person decides.** The first time a page opens a link of such a scheme (a click or a `window.open`), the
external-link question lists each app that lists it (at most two, *provisional*: the panel's row holds four buttons),
"Open with your system's app" and Cancel. A box, "Always use the app I pick for magnet links", makes the app picked the
default; it never applies to the system's app, which is asked about every time. With a default, a later link reaches
the app with no question, and the existing rule that a page needs a click between two questions applies to the
delivery as well. Settings, under Apps, lists "Opens magnet links" on the app's card with Stop. Ending an app's last
grant ends its defaults, so a default does not come back with the next grant.

**An app asks to be the default.** `orivon.app.requestSchemeHandler(scheme)` asks the person the same way, naming the
app, and resolves true only if they agree. It needs a click or key press in the page (it resolves false without one,
with no question), and resolves false for a scheme the app did not list or the browser never routes. `isSchemeHandler`
reports the choice.

**Delivery.** The tab already on the app's origin is shown (in any window), else a new tab opens at the origin in the
window the link came from. `orivon.app.onOpenUrl(listener)` hears each link once. The shell holds a link routed before
any page listens, at most 16 per app and for two minutes, and gives it to the first listener that registers; a page
that leaves is never handed one. A page has no push channel, so the preload waits for the next link with a long poll
of `app.nextOpenUrl` (25 s a wait), the way `web.awaitClose` waits.

**The `electron` shim.** `app.setAsDefaultProtocolClient(scheme)` runs `requestSchemeHandler` and answers `true` only if
the app already is the default and `false` while it asks; `isDefaultProtocolClient` reads the state at `whenReady()`
and the app's own requests since. `removeAsDefaultProtocolClient` answers `false`: the person takes a default back in
Settings. `app.on('open-url', (event, url))` is fed by `onOpenUrl`, and any other `app` event refuses by name.

**Not now.** Orivon as the operating system's handler for a scheme (a link clicked in another program) and file types
(a `.torrent` file opened from the desktop). Each needs registration per platform, and a package registers only the
names ADR-0057 allows. The address bar's typed `magnet:` address is not routed either: it does not reach the gate.

## Context
The manifest's `protocols` was validated and used by nothing, and a `magnet:` click met a gate that could only hand the
link to the operating system. A ported torrent client declares the scheme and expects a click to reach it, which
Electron gives through `open-url` and `setAsDefaultProtocolClient`. Declaration alone must not win the link
(security-model.md T23): the person decides which app, and an app that declares is not offered until it holds a grant.

## Alternatives considered
- **Register the app with the operating system.** A link from another program would open it, but this needs per-platform
  registration the browser does not own for an app, and a page-level click still needs the choice. Left for later.
- **An app listing as the default by order of arrival.** The contract promised conflicts are resolved by the person;
  an order of arrival hands the default to whichever app loads first.
- **Always open the first app that declares the scheme.** An app the person never chose would receive links a page
  picks, including a hostile page's. Rejected; every first use asks.
- **Push the link to the page over a message port.** Needs a channel per page for one rare event. The long poll uses
  the control channel that already carries the origin's identity and its rate limit.
- **Offer every declaring app.** The panel's row holds four buttons; two apps are what the only app that declares the
  scheme has needed. Settings does not list apps that were never chosen.

## Reasoning
The question reuses the one the gate already asks, so the page still cannot launch anything without a person's click,
and an app's name is shown as claimed, never as the identity. Delivery goes through the broker's control channel, so the
origin that receives a link is derived from the sending frame and a grant must still hold. A URL is checked against its
grammar twice: when the gate reads it and again when it is queued.

## Consequences
A page can now cause a tab to open on an installed app and place a link in its inbox, once per click and only after the
person chose that app. An app must treat the string as untrusted input. Two parts are *provisional*: the two-app limit
of the question and `requestSchemeHandler` resolving false rather than rejecting when the page has no gesture; the first
is settled by an app pair that both declare one scheme, the second by an app that needs the difference.

## Reversibility
- **Cost to reverse:** moderate: three calls on `orivon.app` that apps written for them would lose.
- **What would make us revisit:** an app that needs a scheme the browser keeps for itself, or a platform that lets an
  app register with the system for the scheme it is chosen for.
