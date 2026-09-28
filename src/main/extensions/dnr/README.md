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
listener, and does not know it is running inside Electron at all). Nothing in Orivon wires
`evaluate()` into a real session's `webRequest`, or into extensions' `chrome.declarativeNetRequest`
API surface, yet.
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

**`domainType` (`firstParty`/`thirdParty`) reads a real public suffix list.**
`vendor/firefox-dnr/adapters/dnr-domain.mjs` replaces `Services.eTLD.getBaseDomain` (Firefox's
compiled-in PSL) with `tldts` (MIT, pure JS, no install script), including its PRIVATE-section
entries (`github.io` and similar), the same choice Firefox's own eTLD service makes. `.orivon`,
`.eth` and `<cid>.ipfs.orivon` are not on the PSL at all; that file's own doc comment says what
`tldts` returns for each and why it is acceptable (in short: sensible for `.orivon`/`.eth`,
one label too broad for `<cid>.ipfs.orivon`, same failure shape the old fixed-list heuristic
had for `github.io`, and only the `domainType` condition can be affected --
`requestDomains`/`initiatorDomains`/`excludedRequestDomains`/`excludedInitiatorDomains` do not
call `getBaseDomain` at all).

**A per-`Ruleset` index pre-selects candidate rules, instead of testing every rule against
every request.** `vendor/firefox-dnr/UPSTREAM.md` patch 10 has the exact mechanism
(`Ruleset#getCandidateRules`, built from `Rule#condition.requestDomains` and a strict subset of
`urlFilter` shapes: exactly `||<domain>^` or `||<domain>/...`) and why a rule that is not
domain-shaped this way must stay in the always-tested generic list. Two things make the index
safe to add without re-deriving the matching algorithm: `compareRule` is a total order (rule
`id` is unique within a ruleset, and `rulesetPrecedence` differs across rulesets, so no two
distinct rules ever compare equal), so the winning rule for a request does not depend on scan
order, only on the *set* of rules scanned; and `getMatchingModifyHeadersRules` sorts its output
before returning it. `getCandidateRules` still preserves the unindexed scan's relative order
(merging matched domain buckets with the generic list by original array position), so the
result is not just correct but structurally identical to a full scan restricted to the same
rules. `tests/index-equivalence.test.ts` proves this over the Chrome/Firefox test vectors and
(opt-in, same gate as the performance test) uBlock Origin Lite's full default ruleset: every
request evaluated once with the index on and once with `ExtensionDNR.__setRuleIndexEnabledForTesting(false)`,
decisions asserted identical. **Measured limit**: uBOL's own default rulesets are ~38% rules
with no domain-shaped condition at all (a plain substring or wildcard `urlFilter`, or a
`regexFilter`), which the index cannot narrow; see the performance test paragraph below for
what that leaves the median/p99 at.

**`redirect.extensionPath` resolves against `chrome-extension://<extensionId>/`.** Chrome/Firefox
resolve it against the calling extension's own origin. This engine has no origin registry of its
own, so it assumes Orivon serves each extension's resources at `chrome-extension://<extensionId>/`,
matching `vendor/electron-chrome-extensions`'s own convention of using the extension id as the
host. If extensions ever get a different origin scheme, `dnr-engine.ts`'s `computeRedirectUrl`
is the one place to change.

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

**The performance test (`tests/perf.test.ts`) and the uBOL half of
`tests/index-equivalence.test.ts` are gated on `ORIVON_DNR_PERF`** and need a real, unpacked
uBlock Origin Lite build (not committed; download `uBOLite_*.chromium.zip` from
[uBlockOrigin/uBOL-home releases](https://github.com/uBlockOrigin/uBOL-home/releases) and point
`ORIVON_DNR_PERF_UBOL_DIR` at the unzipped folder) -- see `perf.test.ts`'s top comment for the
exact command. Both are excluded from `npm test` because loading ~18,700 real rules and
evaluating thousands of requests takes several seconds, well past this package's default-run
budget.

Measured on the machine this index was built on (10,000 `evaluate()` calls over uBOL's six
default-enabled rulesets, 18,664 rules): a full scan (index disabled) runs median 2.1ms, p99
5.6ms per request; with the index, median 0.69ms, p99 1.3ms -- roughly a 3x/4x improvement, not
the low-double-digit-microsecond figure a fully domain-anchored ruleset would allow, because
close to 40% of uBOL's own rules (plain substring or wildcard `urlFilter`, `regexFilter`) have
no domain-shaped condition for the index to use and stay in the generic, always-tested list (see
the Design notes entry above). Narrowing that further -- e.g. a token/substring index over the
generic `urlFilter` set -- is out of scope here and would need its own equivalence proof.
