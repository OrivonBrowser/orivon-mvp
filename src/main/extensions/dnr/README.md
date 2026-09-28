# `src/main/extensions/dnr/`: a pure `declarativeNetRequest` rule engine

**What lives here.** `createDnrEngine()` (`dnr-engine.ts`): validates rules, holds an
extension's static/dynamic/session rulesets, and evaluates one request to a `DnrDecision`
(cancel, redirect, upgrade-to-https, header-modification ops, and the matched-rule list), in
Chrome's documented `declarativeNetRequest` precedence. `types.ts` is the rule/request/decision
shape. `resource-types.ts` maps Electron's `webRequest` resource-type spelling to Chrome's.
`frame-ancestry.ts` reconstructs a request's frame ancestry (for `allowAllRequests` inheritance)
from `frameId`/`parentFrameId` observed across calls, since this package has no live frame tree
to read one from. The actual matching algorithm is
[`vendor/firefox-dnr`](../../../../vendor/firefox-dnr) (MPL-2.0, ported from Firefox's
`ExtensionDNR.sys.mjs`; `UPSTREAM.md` has the revision and the full patch list) --
`dnr-engine.ts` is a thin, typed orchestration layer over it, not a second implementation.

**What it depends on.** `vendor/firefox-dnr/` only; otherwise pure TypeScript (`URL`, `Map`,
`Set` -- no `node:*`, no third-party package).

**What it must never import.** `electron` (this engine has no `session`, no `webRequest`
listener, and does not know it is running inside Electron at all -- wiring it into a real
session's `webRequest` and into extensions' `chrome.declarativeNetRequest` API surface is a
later package, per `docs/planning/extensions-build-plan.md`'s package 8/9 split).
[`src/renderer/`](../../../renderer/): main-process code, same rule as the rest of `src/main/`
(`../../README.md`).

**Durable.** Everything in this directory is pure logic with no Electron dependency, so unlike
most of `src/main/extensions/`, none of it is tied to Electron.

**Owner stream.** `extensions` (this build's `stream/ext-dnr`).

## Design notes

**`evaluate()` does not check host permissions, and neither does the vendored engine
underneath it.** Chrome's `declarativeNetRequest` normally requires an extension to hold either
the broad `declarativeNetRequest` permission (rules may block/redirect/upgrade but not modify
headers or match on `urlFilter` for hosts the extension cannot access) or
`declarativeNetRequestWithHostAccess` (full behavior, gated per-host). Upstream Firefox enforces
this per request (`RequestDetails#canExtensionModify`, `RuleManager#hasBlockPermission`). This
engine does not: `evaluate()` always matches as if the calling extension holds full permission,
because *which* permission an extension has, and whether it should even reach this engine for a
given origin, is Orivon's broker/manifest-policy concern (`src/broker/policy/extension-manifest.ts`),
layered above this package, not a fact the rule matcher itself should hold. A caller wiring this
into a real session is expected to have already refused anything that should not reach
`evaluate()` at all. `vendor/firefox-dnr/UPSTREAM.md` patch 8 has the exact removed methods.

**Frame ancestry is reconstructed from observation, not read from a live tree.** Firefox's
`RequestDetails#ancestorRequestDetails` walks `nsIBrowsingContext.parent` to find whether an
ancestor frame carries an `allowAllRequests` rule that should override a subresource's own
match. A pure engine has no such tree. `frame-ancestry.ts`'s `FrameAncestryTracker` instead
records every `main_frame`/`sub_frame` request `evaluate()` sees (keyed by `tabId`+`frameId`,
capped at 2000 entries, oldest evicted first) and reconstructs the chain by walking
`parentFrameId` pointers backward. Practical consequence: `evaluate()` must see a tab's document
and frame loads *before* their subresources for `allowAllRequests` inheritance to apply --
true of any real `webRequest.onBeforeRequest` wiring, since a subresource cannot load before its
document does. A frame never recorded (including every request before the first `main_frame`
load a caller feeds this engine) yields no ancestry, the same fallback Firefox uses when its own
frame tree is not "current" for a request.

**`domainType` (`firstParty`/`thirdParty`) is a fixed-list heuristic, not a public suffix
list.** `vendor/firefox-dnr/adapters/dnr-domain.mjs` replaces `Services.eTLD.getBaseDomain`
(Firefox's compiled-in PSL) with a short list of common two-label ccTLD suffixes (`co.uk`,
`com.au`, ...). **Provisional**: a host under an unlisted multi-label suffix (e.g.
`example.github.io`) is graded one label too broad. `requestDomains`/`initiatorDomains`/
`excludedRequestDomains`/`excludedInitiatorDomains` do not use this heuristic and are
unaffected; only the `domainType` condition can be wrong, and only for a host outside the fixed
list. What would settle it: vendoring an actual public-suffix-list data file, if a real
ruleset's `domainType` accuracy on such a host turns out to matter.

**`redirect.extensionPath` resolves against `chrome-extension://<extensionId>/`.** Chrome/Firefox
resolve it against the calling extension's own origin. This engine has no origin registry of its
own, so it assumes Orivon serves each extension's resources at `chrome-extension://<extensionId>/`,
matching `vendor/electron-chrome-extensions`'s own convention of using the extension id as the
host. If a later package gives extensions a different origin scheme, `dnr-engine.ts`'s
`computeRedirectUrl` is the one place to change.

**Rule limits are Chrome's published numbers, not Firefox's pref defaults, and do not model
Chrome's dynamic-rule "safe"/"unsafe" split.** `vendor/firefox-dnr/src/dnr-limits.mjs` has the
full table and reasoning; the short version is D1's compatibility goal (an extension built
against Chrome's ceiling should not be rejected below it) outweighs matching Firefox's own,
more conservative defaults.

**A `modifyHeaders` "append" op on `cookie` does not carry a merge-separator hint.** Chrome
joins repeated `Cookie` headers with `"; "` rather than the default `", "`; Firefox's upstream
implementation reads the channel's *current* header value at apply time to decide this.
`evaluate()`'s request shape carries no existing headers (it answers "what should happen to this
request", not "what is this request's current state"), so this engine cannot replicate that
check. A caller applying `DnrDecision.requestHeaders` ops against real request headers is
responsible for using `"; "` when appending to `Cookie` specifically, `", "` for every other
header, per RFC 6265/7540.

**Where the tests came from.** `tests/fixtures/chrome-parity-urlfilter-vectors.json` is Chrome's
own `#matching-algorithm` test table (developer.chrome.com), as carried into Firefox's
`test_ext_dnr_urlFilter.js` (`test_chrome_parity`); `tests/fixtures/ambiguous-urlfilter-vectors.json`
is that same file's `ambiguous_urlFilter_patterns`/`urlFilter_domain_anchor` coverage. Both were
mechanically extracted from the fetched xpcshell test source (object/array literals evaluated
with `new Function`, not hand-transcribed) at the revision `vendor/firefox-dnr/UPSTREAM.md`
records, then reviewed by hand; one vector using a non-`http(s)` `file:` URL was dropped, since
this engine (like Firefox's own DNR) only operates on http(s) requests. The remaining test files
(`precedence`, `allow-all-requests`, `modify-headers`, `redirect`, `domain-conditions`,
`rule-management`) are hand-written against the same xpcshell suites' scenarios
(`test_ext_dnr_allowAllRequests.js`, `test_ext_dnr_modifyHeaders.js`,
`test_ext_dnr_redirect_transform.js`, `test_ext_dnr_domainType.js`,
`test_ext_dnr_dynamic_rules.js`, `test_ext_dnr_static_rules_limits.js`) rather than extracted,
because those tests drive a real extension through Firefox's WebExtensions test harness and have
no vector table to mine.

**The performance test (`tests/perf.test.ts`) is gated on `ORIVON_DNR_PERF`** and needs a real,
unpacked uBlock Origin Lite build (not committed; download `uBOLite_*.chromium.zip` from
[uBlockOrigin/uBOL-home releases](https://github.com/uBlockOrigin/uBOL-home/releases) and point
`ORIVON_DNR_PERF_UBOL_DIR` at the unzipped folder) -- see that file's top comment for the exact
command. It is excluded from `npm test` because loading ~18,700 real rules and evaluating 10,000
requests takes several seconds, well past this package's default-run budget.
