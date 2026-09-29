# ADR-0045: `window.orivon` refuses code that comes from an extension; a filter, not a sandbox

- **Status:** accepted
- **Date:** 2026-09-29
- **Type:** security
- **Decided by:** owner, for refusing extension code and for dropping `'unsafe-inline'` from
  granted apps; AI recommendation, accepted by default, for the call-stack mechanism.

## Decision

Every call into `window.orivon` is attributed from its JavaScript call stack, captured in the
page's main world by the object's own code with intrinsics saved when the preload installs it.
A call is refused, with the capability's ordinary `denied` failure, when a frame of its stack, or
the origin of an `eval` in it, is an extension's script (`chrome-extension://`); when no frame is
the page's own code; or when the stack machinery has been tampered with. Orivon's own main-world
plumbing calls the functions it captured before they were wrapped, so it is never attributed.

An app a person has granted permissions to is served with `script-src` without
`'unsafe-inline'`: an inline `<script>`, an inline event handler or a `javascript:` URL does not
run there.

This is a filter. It stops extension code from calling `window.orivon`, and it does not make an
extension that runs on a page unable to affect what that page does.

## Context

Extensions run on every page, as one instance, including granted apps (ADR-0044). The owner
decided that code coming from an extension may not use `window.orivon` unless that extension
holds a permission for it. Chromium gives an extension several ways to put code in a page's main
world, the one `window.orivon` lives in: a `"world": "MAIN"` content script, a web-accessible
`<script src>`, `chrome.scripting.executeScript` in the main world. Code there is, to Chromium,
the page's own. The broker knows a caller only by its frame (`src/broker/transport/ipc.ts`), so
it cannot tell them apart. Measured on Electron 44
(`docs/planning/spike-results/extension-stack-probe.json`): a stack taken in the isolated world
across `contextBridge` shows only the preload's own frames; taken in the main world, it names the
extension's script for every route above, and for `eval`, `new Function`, string timers,
`javascript:` URLs, `scripting` func injection and deferred bound calls through the rule "no page
frame, refuse".

## Alternatives considered

- **No extensions on granted apps** (exploration N3). The only arrangement in which Orivon's
  permission is a wall; the owner chose extensions on every page.
- **Block each injection route** (strip MAIN content scripts, wrap `chrome.scripting`, refuse
  web-accessible resources on granted origins). Breaks the extensions people want most, ad
  blockers' scriptlets run in the main world, and leaves the inline and DOM routes open.
- **Stack attribution alone.** An extension can write an inline `<script>`, which runs as page
  code and whose stack names only the page; `'unsafe-inline'` is what makes that work on a
  granted app.
- **A permission per call from the extension's own principal.** That is the `self` permission,
  a separate decision; it does not cover code the extension puts in the page.

## Reasoning

Attribution in the main world is the only place the information exists; saving the intrinsics
before any page or extension script runs makes the capture independent of `window.Error` and
recoverable from a plain reassignment of its properties, and a property made unconfigurable is
detected rather than trusted. Dropping `'unsafe-inline'` closes the one route that turns
extension code into code whose stack is the page's. What remains is stated rather than claimed
away, in the manner of ADR-0021.

## Consequences

- An extension can still change what a granted app's page does: the values in a form, the
  address a page is about to ask the person to sign for. Every Chromium browser has the same
  exposure to an extension with access to a site; the install prompt names the sites.
- Code the page itself runs stays the page's, whoever scheduled it: a page function that
  evaluates a string (an eval gadget), handed an extension's string through a timer, calls
  `window.orivon` as the page. So does any use of an object the page already holds, such as an
  open socket or file handle, by code that gets hold of it; the filter guards the calls on
  `window.orivon`, not the handles they return. The same is true one level up: an extension can
  plant a bound `window.orivon` method (`orivon.fs.readFile.bind(...)`) in a slot the page itself
  calls -- a hook, `console.log` -- and the page's own call to that slot runs it with the page's
  frame on the stack; the filter sees only that frame, never that an extension chose what sits
  behind it.
- An extension that makes `Error.prepareStackTrace` or `Error.stackTraceLimit` unconfigurable
  makes every `window.orivon` call on that page refuse: a denial of service an extension with
  access to the page could cause in other ways.
- A page's own call made from a callback with no page frame on the stack (a bound
  `orivon` method passed straight to `setTimeout` or `addEventListener`) is refused. Calls from
  the page's own functions, including `async` ones after an `await`, keep their frames.
- An app that needs inline scripts does not work once the person grants it a permission. A
  pinned app could keep its own inline scripts through `'sha256-...'` sources Orivon computes
  from the HTML it serves; that is not built.
- Each call pays the capture, about 5 microseconds measured.
- A document a service worker serves from its own cache never reaches `onHeadersReceived`, so a
  granted app that precaches its shell can run with `'unsafe-inline'` restored once a service
  worker controls it; the call-stack refusal on `window.orivon` itself does not depend on CSP
  and still applies there.

## Reversibility

- **Cost to reverse:** cheap for the filter (remove the wrap); moderate for the CSP, since apps
  may by then rely on its absence of inline script.
- **What would make us revisit:** Chromium or Electron exposing which script world or extension
  a call came from; an extension-held permission to act as the page (the owner's "a specific
  permission"), which would add an allow list to the rule rather than change it.
