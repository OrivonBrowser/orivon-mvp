# ADR-0053: Orivon serves extensions' `webRequest` listeners itself, from its one owner per event

- **Status:** accepted
- **Date:** 2026-10-02
- **Type:** architecture
- **Decided by:** owner, for making full uBlock Origin work by changing Orivon rather than the
  extension; AI recommendation, accepted by default, for where the listeners run and how their
  answers combine.

## Decision

Orivon serves `chrome.webRequest` to extensions itself. The loaded copy still has `webRequest` and
`webRequestBlocking` removed (`ADR-0043`); an extension that declared them registers each listener
with main, and main sends it the requests from the default session's `webRequest` owner
(`ADR-0044`):

- The three events that can change a request (`onBeforeRequest`, `onBeforeSendHeaders`,
  `onHeadersReceived`) run at order 1100: after the extensions' `declarativeNetRequest` rules (1000)
  and Orivon's privacy and site settings, before the handlers that run last (the verifier's
  partition stamp, a granted app's CSP, the sandbox CSP), which no listener can alter.
- The five that only report (`onSendHeaders`, `onResponseStarted`, `onBeforeRedirect`,
  `onCompleted`, `onErrorOccurred`) become fan-out events of the same owner.
- A blocking listener needs `webRequestBlocking` and manifest version 2, as in Chrome; a manifest
  version 3 extension may only observe. Main waits at most 10 seconds for a blocking answer, then
  lets the request go on without it.
- An extension sees a request only as Chrome would show it: from a page in the default session,
  never Orivon's own main-process requests, an `orivon:` page, another extension's pages or the
  Chrome Web Store; and only with host access to the URL and, for a subresource, its initiator.
  A request whose address, initiator or page is a registered app's origin is hidden too, as every
  other extension API leaves apps out.
- Answers combine as Chrome combines them: any cancel wins; the most recently installed
  extension's redirect wins, and a redirect may go only to the web, `data:`, `about:blank` or the
  extension's own files; each header change applies as its difference from the original, oldest
  install first, so a newer install's replacement of a header prevails. A header list holding a name
  that is not an HTTP token or a value with CR, LF or NUL is ignored whole, and `Host` never changes.
- A page holds its listeners only while it shows its extension: one that is gone, crashes or
  navigates away loses them, and a listener number the page no longer knows is answered at once.

## Context

The owner reported that full uBlock Origin (MV2) does almost nothing on adblock.turtlecute.org.
Measured: uBlock Origin blocked no request at all, because it blocks only through blocking
`webRequest` listeners and Orivon never called one. `ADR-0043` removed the permission because
Chromium's own handling crashes `net.fetch` on the session, and named Orivon's own request-filtering
engine, on the one `webRequest` listener per event Orivon owns, as what would serve it instead;
`ADR-0051` built the `declarativeNetRequest` half.

## Alternatives considered

- **Give the permission back to Chromium.** Measured: the first `net.fetch` on the session crashes
  the main process, and any embedder listener (Orivon has several) silences an extension's own
  `webRequest` anyway.
- **Ask people to use uBlock Origin Lite.** It already works through `declarativeNetRequest`, but the
  owner asked for the full extension, whose per-site switches, scriptlet timing and CSP injection
  need `webRequest`.
- **A built-in blocker.** Rejected in `ADR-0051` for the same reason: the extension the person chose
  would still do nothing.

## Reasoning

Running the listeners inside the one owner per event keeps a single place that decides what happens
to a request, so Orivon's own last handlers still run after every extension, exactly as they do
after `declarativeNetRequest`. Keeping Chrome's visibility and combining rules means an extension
written for Chrome behaves as it does there.

## Consequences

- Each request an extension listens to crosses to its background page or worker and back; a
  blocking listener adds that round trip to the request, as it does in Chrome for MV2.
- A blocking listener that never answers delays its requests by the timeout, never forever.
- `onAuthRequired` listeners are accepted and never called; a `requestBody` carries raw bytes only,
  never `formData`; `filterResponseData` (Firefox's) is absent.
- A service worker's listeners hear events only while the worker runs, where Chrome would wake it.
- A redirect to the extension's own file is followed by a script or an image, but a page's
  `fetch()` fails it with `ERR_UNSAFE_REDIRECT` (A350).

## Reversibility

- **Cost to reverse:** moderate. The dispatcher sits behind `src/main/extensions/`.
- **What would make us revisit:** Electron serving an extension's `webRequest` alongside an
  embedder's listeners and `net.fetch`.
