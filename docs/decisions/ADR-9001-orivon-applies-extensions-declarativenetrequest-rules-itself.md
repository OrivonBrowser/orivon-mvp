# ADR-9001: Orivon applies extensions' `declarativeNetRequest` rules itself, with Firefox's matcher

- **Status:** accepted
- **Date:** 2026-09-29
- **Type:** architecture
- **Decided by:** owner, for porting Firefox's matcher rather than shipping a built-in blocker;
  AI recommendation, accepted by default, for where the rules run and in what order.

## Decision

Orivon serves `chrome.declarativeNetRequest` to extensions and enforces their rules itself.
The matcher is Firefox's (`vendor/firefox-dnr`, MPL-2.0, patches listed in its `UPSTREAM.md`),
wrapped by `src/main/extensions/dnr/` with Chrome's limits and an index that finds candidate
rules by request domain and by a token each rule must contain.

- Static rulesets load from the extension's own folder; dynamic rules and the enabled rulesets
  persist per install; session rules live in memory. An uninstall removes the persisted state.
- The rules run in the default session's `webRequest` owner (ADR-0044), before Orivon's own last
  handlers, so no rule can alter the partition stamp or a granted app's CSP. The handlers are
  registered only while a loaded extension has rules.
- Only requests from a webContents in the default session are matched. Orivon's own
  main-process requests are not; neither, today, are websites' service-worker and shared-worker
  requests, which Electron reports with no webContents either.
- `redirect` and `modifyHeaders` need host permission for the request, and for its initiator
  when it is not a navigation, as in Chrome; `block`, `allow` and `upgradeScheme` do not, unless
  the extension holds only `declarativeNetRequestWithHostAccess`.

## Context

MV3 content blockers (uBlock Origin Lite, AdGuard) are built on `declarativeNetRequest`. Electron
does not implement it: static rules never apply, and any embedder `webRequest` listener silences
dynamic and session rules too (measured on Electron 44). Orivon needs its own `webRequest`
listeners on the default session, and an extension carrying the permission makes the first
`net.fetch` on that session crash the main process (ADR-0043), so Orivon strips the permission
from the copy it loads.

## Alternatives considered

- **Electron's own engine, fed dynamic rules.** It is silenced by Orivon's own listeners, and
  uBOL's static rules would have to be squeezed into Chrome's dynamic and session caps.
- **A built-in blocker (`@ghostery/adblocker`)**. Blocking on for everyone, but extensions built
  on dNR would load and block nothing.
- **Writing a matcher.** Firefox's is a production implementation of the same specification,
  with its own test vectors, in JavaScript.

## Reasoning

Firefox built its engine to Chrome's semantics, so porting it keeps the precedence rules,
`allowAllRequests` frame inheritance and URL filter grammar exact. Running it inside Orivon's
one `webRequest` owner keeps a single place that decides what happens to a request, and lets
Orivon's own handlers run after every extension rule.

## Consequences

- Matching costs about 50 microseconds per request with uBlock Origin Lite's 18,664 rules, and
  about 0.3 ms per request end to end, measured.
- Rule conditions the engine cannot evaluate (`responseHeaders`, the deprecated `domains`
  aliases) are refused when the rule is added; a static ruleset keeps its other rules.
- Websites' worker requests are not matched until Orivon can tell them from its own.
- The vendored engine is updated by re-copying Firefox's file and re-applying the patch list.

## Reversibility

- **Cost to reverse:** moderate. The engine sits behind `src/main/extensions/dnr/`.
- **What would make us revisit:** Electron implementing `declarativeNetRequest` in a way that
  coexists with an embedder's `webRequest` listeners and with `net.fetch`.
