# `src/main/extensions/dnr/`: an Electron-free `declarativeNetRequest` rule engine and its I/O

**What lives here.** `createDnrEngine()` (`dnr-engine.ts`): validates rules, holds an
extension's static/dynamic/session rulesets, and evaluates one request to a `DnrDecision`
(cancel, redirect, upgrade-to-https, header-modification ops, and the matched-rule list), in
Chrome's documented `declarativeNetRequest` precedence. `types.ts` is the rule/request/decision
shape. `resource-types.ts` maps Electron's `webRequest` resource-type spelling to Chrome's.
`frame-ancestry.ts` reconstructs a request's frame ancestry (for `allowAllRequests` inheritance)
from `frameId`/`parentFrameId` observed across calls, since this package has no live frame tree
to read one from. `host-permissions.ts` builds the `redirect`/`modifyHeaders` host-permission
gate (`DnrActionAccess`, see this file's Design notes) from an extension's permission names and
host match patterns, matched by `../../../broker/policy/extension-host-patterns.ts`'s
`matchesAnyHostPattern` -- the one Chrome match-pattern matcher, not a second implementation of
that grammar either. `dnr-runner.ts` is the thin, Node-only I/O layer `../extensions-dnr.ts`
(Electron-tied, one level up) calls to read a static ruleset's rules from an extension's loaded
folder and to persist dynamic rules and enabled-ruleset choices, and `../install-runner.ts` calls
(`clearPersistedRuleState`) to delete both on uninstall. The actual matching algorithm is
[`vendor/firefox-dnr`](../../../../vendor/firefox-dnr) (MPL-2.0, ported from Firefox's
`ExtensionDNR.sys.mjs`; `UPSTREAM.md` has the revision and the full patch list) --
`dnr-engine.ts` is a thin, typed orchestration layer over it, not a second implementation.

**What it depends on.** `vendor/firefox-dnr/` (the engine); `node:fs`, `node:path` and
`../../../broker/grants/node-ledger-storage.js`'s `writeFileAtomic` (`dnr-runner.ts` only, for
its own disk I/O); `../../../broker/policy/extension-host-patterns.ts`'s `matchesAnyHostPattern`
(`host-permissions.ts` only, pure and Electron-free itself). Otherwise pure TypeScript (`URL`,
`Map`, `Set` -- no third-party package). `node:*` is a runtime dependency, not an Electron one:
nothing here calls into `electron` itself, so the whole directory stays durable (see below).

**What it must never import.** `electron`, from any file in this directory including
`dnr-runner.ts` (it does disk I/O with plain `node:fs`, never a `session`, and does not know it
is running inside Electron at all), or [`src/renderer/`](../../../renderer/). The wiring that
reads this into a real session -- `evaluate()` into `webRequest`, and extensions'
`chrome.declarativeNetRequest` API surface -- lives one level up, in
`../extensions-dnr-subsystem.ts`, tied to Electron (same rule as the rest of `src/main/`,
`../../README.md`).

**Durable.** Everything in this directory runs with no Electron dependency, so unlike most of
`src/main/extensions/`, none of it is tied to Electron -- `dnr-runner.ts`'s disk I/O included,
since it depends only on `node:fs`/`node:path` and this repository's own atomic-write helper,
none of them Electron-specific.

**Owner stream.** `extensions` (this build's `stream/ext-dnr`).

## Design notes

**`dnr-runner.ts`'s on-disk layout is this repository's own choice, not a Chrome-documented
file.** `<userData>/extensions/<slot>/dnr-dynamic.json` holds the extension's dynamic rules;
`dnr-enabled-rulesets.json`, alongside it, holds
the static-ruleset ids the extension last chose via `updateEnabledRulesets` (absent until the
first call, per-ruleset `enabled` from the manifest until then). Both live at the *slot* level
(`<userData>/extensions/<slot>/`), not the versioned load directory
(`<userData>/extensions/<slot>/<version>/`) `install-runner.ts` deletes on uninstall -- the same
level `<slot>/key.pub` already persists at across an uninstall, for the same reason
(`../README.md`'s slot design: an id installed again into the same slot should stay recognizable).
Unlike `key.pub`, `install-runner.ts`'s `uninstall` deletes both of these two files
(`clearPersistedRuleState`, below), matching Chrome's own behavior of clearing an extension's
dynamic rules and enabled-ruleset choice on uninstall: a reinstall into the same slot starts with
neither, the same as a fresh install into a slot that never held one.

**`evaluate()` gates `redirect`/`modifyHeaders` on host permission through a predicate the
caller supplies, not through any notion of "permissions" of its own.** Chrome's
`declarativeNetRequest` requires an extension to hold either the broad `declarativeNetRequest`
permission (rules may block/redirect/upgrade but not modify headers or match on `urlFilter` for
hosts the extension cannot access) or `declarativeNetRequestWithHostAccess` (full behavior, gated
per-host). `setActionAccess(extensionId, access)` (`dnr-engine.ts`, wrapping
`vendor/firefox-dnr/UPSTREAM.md` patch 12's `RuleManager#actionAccess`) is how a caller states,
per extension, which requests it may `redirect`/`modifyHeaders` on (`access.hasHostAccess`) and
whether every action needs that check (`access.requiresHostAccessForAllActions`, set for a
`declarativeNetRequestWithHostAccess`-only extension). `host-permissions.ts`'s
`buildActionAccess` builds this from an extension's DNR-related permission names and host match
patterns; a caller that never calls `setActionAccess` gets this engine's original behavior --
every extension matches as if it held full permission everywhere. *Whether an extensionId holds
`declarativeNetRequest` at all*, and whether it should even reach this engine for a given origin,
stays Orivon's broker/manifest-policy concern (`src/broker/policy/extension-manifest.ts`), not a
fact this package holds itself -- a caller wiring this into a real session is expected to have
already refused anything that should not reach `evaluate()` at all.

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
`regexFilter`), which the domain index cannot narrow -- patch 11 below narrows most of that
remainder instead.

**A token index on the same `Ruleset` narrows most of what the domain index leaves generic.**
`vendor/firefox-dnr/UPSTREAM.md` patch 11 has the exact mechanism and its full soundness
argument (a `urlFilter` rule is only indexed under a token guaranteed to appear as a *whole*
maximal run in any URL it can match, never as part of a longer one) -- the short version:
extract every literal-segment token bounded on both sides by an anchor, a `^` separator, or
another literal character (never by `*` or an unanchored pattern edge), index each rule under
its least-common such token (uBlock Origin's own selectivity heuristic), and leave a rule with
no such token -- or any `regexFilter` rule -- on the generic list, unchanged.
`getCandidateRules` now merges the generic list with both the matched domain buckets and the
matched token buckets, in the same original relative order patch 10 already preserves, for the
same reason (`compareRule`'s total order plus `getMatchingModifyHeadersRules`'s own sort).
`tests/index-equivalence.test.ts`'s "token-index vectors" `describe` block exercises every
boundary kind the soundness argument depends on (always-on, not gated), and its uBOL run adds
over 5,000 requests including URLs built from the loaded rulesets' own patterns. **Measured
effect**: of uBOL's 7,143 rules with no domain-shaped condition, 6,748 (94.5%) get a sound token
and move off the generic list; 395 stay generic for lacking one (a bare wildcard, or a pattern
whose only literal segments are under 3 characters).

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

**A hostless request URL (`data:`, `blob:`, `about:`, `javascript:`) never throws, and a
`requestDomains`/`excludedRequestDomains` condition treats it the same way an absent initiator is
already treated.** `vendor/firefox-dnr/UPSTREAM.md` patch 13 has the exact mechanism (a missing
guard around `RequestDetails#allRequestDomains`, unlike the already-guarded initiator side) and
why Orivon reaches this path at all (`dnr-webrequest.ts` registers on `<all_urls>`; Firefox's own
integration only ever hands DNR a network-scheme request). A rule requiring `requestDomains` does
not match such a request; a rule excluding by `excludedRequestDomains` is not excluded by it.

**A rule condition Chrome accepts but this engine cannot evaluate is refused at validation, not
silently ignored.** `vendor/firefox-dnr/UPSTREAM.md` patch 14 covers `condition.responseHeaders`/
`excludedResponseHeaders` (no response-header state reaches `evaluate()` at all, see the
`modifyHeaders`/cookie entry above for the same limit on the action side) and the deprecated
`condition.domains`/`excludedDomains` aliases (no Firefox implementation to port). Each such rule
is dropped at `RuleValidator#addRules` with a message naming the field, the same per-rule skip
already used for every other condition failure -- a static ruleset that mixes a handful of these
in with thousands of ordinary rules still loads the rest (`dnr-engine.ts`'s
`validateStaticRuleset`, patch 14's own entry has the reasoning); `updateDynamicRules`/
`updateSessionRules` still reject the whole call for one, matching Chrome's transactional
contract for those two APIs.

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
5.6ms per request; with the domain index alone (patch 10), median 0.69ms, p99 1.3ms -- roughly a
3x/4x improvement, not the low-double-digit-microsecond figure a fully domain-anchored ruleset
would allow, because close to 40% of uBOL's own rules had no domain-shaped condition for that
index to use and stayed in the generic, always-tested list (see the Design notes entry above).

With the token index added (patch 11), which narrows 6,748 of those 7,143 remaining generic
rules: **median 52us, p99 174us** -- roughly another 13x/7x improvement over the domain-index-
only numbers, and comfortably under this package's working targets of 60us median / 300us p99.
The 395 rules the token index cannot narrow (no bounded token of at least 3 characters) are why
this is not lower still; narrowing them further would need either a literal-prefix index for
their specific shapes or a lower token-length floor, neither attempted here.
