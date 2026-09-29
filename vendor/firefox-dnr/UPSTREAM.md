# Upstream

- Source: `mozilla-firefox/firefox` (GitHub mirror of mozilla-central),
  `toolkit/components/extensions/`
- Revision: `b333202cd8d8385cb382c42404a03995dbc126ec`
- Date fetched: 2026-09-29
- License: MPL-2.0 (see `LICENSE`) is file-level copyleft. These files stay
  MPL-2.0 inside Orivon's AGPL-3.0-only tree, which MPL-2.0 §3.3 permits.
- Vendored from:
  - `toolkit/components/extensions/ExtensionDNR.sys.mjs` → `src/extension-dnr.mjs`
  - `toolkit/components/extensions/ExtensionDNRLimits.sys.mjs` → `src/dnr-limits.mjs`
  - `toolkit/components/extensions/schemas/declarative_net_request.json` →
    `schema/declarative_net_request.json` (reference only: `src/main/extensions/dnr/types.ts`
    is hand-written against it, nothing here parses or executes it)
- Fetched but **not** vendored: `toolkit/components/extensions/ExtensionDNRStore.sys.mjs`
  (Firefox's on-disk rule store: reads/writes `IndexedDB`-backed static-ruleset
  JSON, applies startup caching). Its `#updateDynamicRules` /
  `#updateEnabledStaticRulesets` methods were read to confirm the *validation
  and quota-checking sequence* `src/main/extensions/dnr/dnr-engine.ts`
  reimplements (RuleValidator → RuleQuotaCounter → apply), but no code was
  copied from it: Orivon holds rules in memory for the lifetime of one
  `createDnrEngine()` call, with no persistence layer in this package.
- Also fetched, mined for test vectors, not vendored as code: the xpcshell
  tests under `toolkit/components/extensions/test/xpcshell/test_ext_dnr_*.js`
  (see `src/main/extensions/dnr/README.md` §Design notes for which ones and
  how).

## What this engine does not do (by design, not merely "not yet ported")

Firefox's `ExtensionDNR.sys.mjs` is one piece of a browser: it wires into
`WebRequest.sys.mjs`'s `ChannelWrapper`, Firefox's own extension-permission
model, and an on-disk rule store. This package is "a pure
`declarativeNetRequest` rule engine" only: validate rules, hold rulesets,
evaluate a request to a decision. Everything below is out of scope for this
package, and none of it was ported:

- `NetworkIntegration` and its `ChannelWrapper`/`nsIURI` glue, `handleRequest`,
  `beforeWebRequestEvent`, `isRestrictedPrincipalURI`: nothing in Orivon calls
  `evaluate()` from a real session's `webRequest` yet; this engine has no
  `session` and does not know it is running inside Electron (see
  `src/main/extensions/dnr/README.md`'s "What it must never import").
- `validateManifestEntry`, `ensureInitialized`, `initExtension`: manifest
  parsing and boot-time loading are not this pure engine's job; they belong
  wherever Orivon reads an extension's manifest (`src/main/extensions/`).
- *Whether an extension holds `declarativeNetRequest` or
  `declarativeNetRequestWithHostAccess` at all* stays a broker/manifest
  concern layered above `evaluate()` -- this package has no notion of
  "does this extensionId have this permission", only of match patterns it is
  handed (see patch 12). A caller must still have already refused an
  extension with neither permission before it ever calls
  `setStaticRulesets`/`updateDynamicRules`/`updateSessionRules` for it.
  *Per-request host-permission gating* (`redirect`/`modifyHeaders`
  specifically, and every action for a `declarativeNetRequestWithHostAccess`-only
  extension) is implemented, patch 12: `RequestEvaluator#isActionAllowed`
  checks a caller-supplied `RuleManager#actionAccess.hasHostAccess(requestURI,
  initiatorURI)` predicate instead of the removed `canExtensionModify`. A
  caller that never calls `createRuleManagerRegistry()`'s `setActionAccess`
  gets this package's original behavior: every extension matches as if it
  held full host permission everywhere.

## Patches

Each numbered patch is cited by number in the corresponding source comment
in `src/extension-dnr.mjs`, so a diff against upstream can be read patch by
patch.

1. **`ExtensionUtils.ExtensionError`/`DefaultWeakMap` → `adapters/dnr-errors.mjs`.**
   `ExtensionUtils.sys.mjs` does not exist outside Firefox. `ExtensionError`
   becomes a plain `Error` subclass (same `.message` text Chrome's own error
   strings use); `DefaultWeakMap` is reimplemented verbatim (it has no
   Firefox-specific behavior, it is just missing from the standard library).

2. **`Services.io.newURI`/`nsIURIMutator` → `adapters/dnr-uri.mjs`, using
   WHATWG `URL`.** `applyQueryTransform` is unchanged (it was already pure);
   `applyURLTransform` is rewritten against `URL`'s setters instead of
   `nsIURIMutator`'s `mutate()`/`finalize()` chain. Behavioural gap: `URL`'s
   setters clamp or silently ignore an invalid component (e.g. a host with
   an illegal character) instead of throwing, so `RuleValidator`'s
   `redirect.transform` validation (which calls `applyURLTransform` on a
   dummy URL to check for a throw) is measurably more permissive than
   Firefox's — a transform Firefox would reject at `updateDynamicRules` time
   may be accepted here and only produce a no-op or best-effort redirect
   target at evaluation time. No test in this package's suite currently
   depends on catching that case; flagged for whoever wires real extensions
   through this engine to watch for.

3. **`Services.eTLD.getBaseDomain` → `adapters/dnr-domain.mjs`.** Firefox
   reads a compiled-in public suffix list; this reads `tldts` (MIT, pure JS,
   no install script), a real public-suffix-list lookup, with
   `allowPrivateDomains: true` so a shared-hosting suffix like `github.io`
   is graded per-user the way Firefox's own eTLD service does — see that
   file's own doc comment for the one class of host (a scheme not on the
   PSL, such as `<cid>.ipfs.orivon`) `tldts` cannot place precisely, and why
   that is acceptable. Used only by the `domainType` (`firstParty`/
   `thirdParty`) condition; `requestDomains`/`initiatorDomains` do not use
   it and are unaffected.

4. **`ExtensionDNRLimits.sys.mjs`'s `XPCOMUtils.declareLazy` pref indirection
   → plain constants in `src/dnr-limits.mjs`, set to Chrome's published
   limits rather than Firefox's own pref defaults.** A pure engine has no
   pref service. The values themselves are also changed where Firefox's
   default differs from Chrome's documented cap (`MAX_NUMBER_OF_ENABLED_STATIC_RULESETS`:
   Firefox 20 → 50; `MAX_NUMBER_OF_DYNAMIC_RULES`: Firefox 5000 → 30000,
   without porting Chrome's separate 5000-rule "safe" sub-quota, which
   `RuleValidator`/`RuleQuotaCounter` have no concept of in either upstream
   Firefox or here) — see `src/dnr-limits.mjs` for the full table and the
   reasoning (D1's compatibility goal: extensions built against Chrome's
   ceiling should not be rejected below it).

5. **`applyRegexSubstitution`'s `extension.checkLoadURI` privileged-URI check
   → a plain http(s) scheme allowlist.** Firefox checks the resulting URL
   against the calling extension's principal (would it be allowed to
   navigate there at all, including Firefox's privileged `about:` pages).
   Orivon has no such principal model here; the replacement only enforces
   that a `regexSubstitution` redirect resolves to `http:`/`https:`, matching
   `declarative_net_request.json`'s own `redirect.url` `"format": "url"`
   restriction. `matchedRule.ruleManager.extensionId` (a string) replaces
   `matchedRule.ruleManager.extension.id`.

6. **`ModifyHeadersBase`/`ModifyRequestHeaders`/`ModifyResponseHeaders` no
   longer mutate a live `ChannelWrapper`.** They collect `{header, operation,
   value}` ops into `this.ops`, in the precedence order the original applied
   them in (`#alreadyModifiedMap`/`#appendStillAllowed` unchanged), for
   `dnr-engine.ts` to return as `DnrDecision.requestHeaders`/`.responseHeaders`.
   `maybeApplyModifyHeaders` returns the ops array instead of calling
   `applyModifyHeaders` on a channel-backed instance. `#checkHostHeader`
   (permission gating on a `Host` header rewrite) is dropped along with the
   other permission checks (see above). The Cookie-header `"; "` merge
   special case, which upstream reads from the channel's *current* request
   headers (`channel.getRequestHeader("cookie")`) to decide, is **not**
   ported: `evaluate()`'s request shape carries no existing headers, so an
   `"append"` op on `cookie` is emitted like any other header and the
   caller applying it against real request headers is responsible for
   joining with `"; "` per RFC 6265/7540 rather than the default `", "`.

7. **`RequestDetails` no longer builds itself from a `ChannelWrapper` or
   walks a live `browsingContext` for `allowAllRequests` ancestry.**
   `fromChannelWrapper` is removed; the constructor takes a plain `{
   requestURI, initiatorURI, type, method, tabId, ancestorRequestDetails }`
   built by `dnr-engine.ts` from Orivon's request shape.
   `ancestorRequestDetails` (a lazy getter walking `bc.parent` upstream) is a
   plain field instead, populated by `src/main/extensions/dnr/frame-ancestry.ts`'s
   `FrameAncestryTracker`, which reconstructs the same root-first ancestor
   chain from `frameId`/`parentFrameId` observed across calls to
   `evaluate()`, since a pure engine has no live frame tree to walk. See
   `frame-ancestry.ts` and the facade README's Design notes for the exact
   behavioural difference (an unrecorded frame yields no ancestry, same as
   Firefox's own `ancestorsAreCurrent`-false fallback).

8. **`RequestEvaluator`'s `canModify` is always `true`.** Upstream computes
   it via `RequestDetails#canExtensionModify` (host-permission check against
   the request and, for non-navigation requests, the initiator). Dropped
   along with the other permission checks (see above); `#isRuleActionAllowed`
   and its `hasBlockPermission` branches are removed entirely rather than
   simplified in place, since with `canModify` fixed to `true` every branch
   they gated was already dead code. Patch 12 below reinstates a version of
   this check, driven by a caller-supplied predicate rather than
   `canModify`/a live `Extension` object.

9. **`gRuleManagers`/`getRuleManager`/`clearRuleManager` become a factory,
   `createRuleManagerRegistry()`, instead of one module-level array.**
   Firefox runs one DNR system per process, so a top-level singleton is
   correct there. `createDnrEngine()` makes an independent engine per call
   (see the facade README); each gets its own registry, keyed by the
   extensionId string (Orivon has no live `Extension` object to key by, or
   to compare with `===`). `clearRuleManager` is renamed `removeRuleManager`
   for symmetry with the facade's `removeExtension`. Insertion order still
   doubles as "most recently registered first" for cross-extension
   precedence, same caveat upstream states (`TODO bug 1786059`): this is not
   a true install-time ordering, just the order `getRuleManager` was first
   called for each extension.

10. **A candidate index on `Ruleset`, not present upstream.** Firefox's own
    `#collectMatchInRuleset` tests every rule in a ruleset against every
    request (this file's top comment says so); `Ruleset#getCandidateRules`
    narrows that to a subset before `#matchesRuleCondition` runs, because
    Orivon calls `evaluate()` once per network request in the main process,
    and a real ad-block ruleset is large enough (uBlock Origin Lite's
    default rulesets: ~18,700 rules) for the full scan to cost low-single-
    digit milliseconds per request (`src/main/extensions/dnr/tests/perf.test.ts`).
    A rule whose condition has `requestDomains`, or a `urlFilter` of exactly
    `||<domain>^` or `||<domain>/...`, is indexed under each such domain;
    every other rule (bare `||<domain>` with nothing after it, `urlFilter`
    without a domain anchor, `regexFilter`, `initiatorDomains`-only, or no
    domain-shaped condition at all) goes in a generic list tested for every
    request, same as before this patch. `getCandidateRules` returns the
    matched buckets merged with the generic list, sorted back into the same
    relative order a full scan of `ruleset.rules` would produce, so it
    cannot change which rule wins a precedence comparison or reorder a
    `modifyHeaders` result; `src/main/extensions/dnr/tests/index-equivalence.test.ts`
    asserts this by running the same rules and requests through both an
    indexed and an unindexed evaluator (`ExtensionDNR.__setRuleIndexEnabledForTesting`,
    called only by that test) and comparing every decision. See
    `src/main/extensions/dnr/README.md`'s Design notes for the measured
    effect and its limit: uBOL's default rulesets still leave close to 40%
    of all rules in the generic list, because that many have no domain-
    shaped condition at all.

11. **A token index on `Ruleset`, also not present upstream, narrowing the
    generic list patch 10 leaves behind.** The technique is the one uBlock
    Origin's own engine uses for the same problem: for a rule whose
    `urlFilter` has no domain-shaped condition (so patch 10 leaves it
    generic), extract every token in its literal segments that is provably
    bounded on both sides, index the rule under whichever candidate token is
    least common across all rules built at the same time (a two-pass build:
    count first, then commit each rule to its rarest candidate, the same
    "most selective bucket" heuristic uBlock Origin uses), and leave a rule
    with no such token -- a pure wildcard pattern, a pattern whose only
    tokens are shorter than 3 characters, or any `regexFilter` rule -- on
    the always-tested generic list, unchanged. A "token" is a maximal run of
    `[a-z0-9%]` characters (`TOKEN_CHAR_RE`), lowercased when the rule is
    case-insensitive (dNR's default -- indexed in `byToken`, looked up
    against the request URL's own lowercased tokens) and left as-is when
    `isUrlFilterCaseSensitive` is `true` (indexed in `byTokenCS` instead,
    looked up against the un-lowercased URL). `Ruleset#getCandidateRules`
    now merges up to three sources -- the (now smaller) generic list, the
    matched domain buckets, and the matched token buckets -- preserving the
    same relative order a full scan would produce, for the same reason
    patch 10's domain buckets do (`compareRule` is a total order over the
    *set* of rules scanned, not their scan order, and
    `getMatchingModifyHeadersRules` sorts its own output).

    **Soundness.** The risk a token index runs is a false negative: indexing
    a rule under token T is only sound if T is guaranteed to appear in any
    URL the rule can match as a whole maximal `[a-z0-9%]` run, never merely
    as part of a longer one (the rule's pattern might contain `ads`, but the
    URL might contain `loads` -- T would be "there" as a substring without
    being a token match). `extractIndexTokenCandidates` only accepts a
    candidate run that is bounded on **both** sides by one of: an anchor
    (`||`, a leading `|`, or a trailing `|`, exactly where
    `CompiledUrlFilter`'s own `#initializeUrlFilter` computes one), a literal
    `^` separator in the pattern, or another literal (non-token) character
    in the same literal segment. It is never bounded by `*` (an unindexed
    wildcard can sit anywhere) or by the pattern's own start/end without an
    anchor there (an unanchored head/tail is matched by `#indexAfterPart`
    with an unconstrained `url.indexOf`, per this file's own top-of-class
    comment on `CompiledUrlFilter`). Three boundary kinds, three arguments:

    - **A literal (punctuation) character.** `#matchesRuleCondition` requires
      that exact character at that exact URL position (`#matchPartAt`'s
      `partChar !== urlChar` branch). Since the character is by construction
      not in `[a-z0-9%]`, any URL that truly matches has that same
      non-token character adjacent to T, which is exactly where the token
      scanner (the same `[a-z0-9%]+` run extraction, run once over the
      request URL and cached on `RequestDataForUrlFilter`) also stops a run.
    - **An anchor.** A domain anchor requires T to start at one of
      `domainAnchors` -- offsets computed only right after `://`, `@`, or a
      `.` in the host (`#getDomainAnchors`) -- each of which is a character
      outside `[a-z0-9%]` in *any* URL, matching or not, so it is always a
      run boundary. A left anchor requires T to start at URL index 0, and a
      right anchor (or the pattern's own trailing `^`, still present as a
      literal in `#urlFilterParts` since only wildcards and `|` are trimmed
      before the split) requires T to end at the URL's real end (or its
      appended `^`) -- both are string edges, which bound a run trivially.
    - **A literal `^` separator.** This is the one that needs its own
      argument, because the matcher's separator class and the token class
      are not the same set. `CompiledUrlFilter`'s `#regexIsSep` accepts
      `^` matching any character **outside** `[A-Za-z0-9_\-.%]` -- so `_`,
      `-`, `.` and `%` do *not* satisfy a pattern `^`, only a "harder"
      separator (`/`, `:`, `?`, space, ...) does. The token class
      `[a-z0-9%]` is a strict subset of that non-separator set
      (`[A-Za-z0-9_\-.%]`), so its complement -- the set of characters that
      break a token run -- is a strict *superset* of the matcher's true
      separator set. Consequently: whenever a pattern `^` genuinely matches
      (the URL holds a real separator there), that same character is also
      outside `[a-z0-9%]`, so the token scanner breaks a run there too. The
      token scanner can (and does) break runs in *more* places than the
      matcher's `^` requires -- e.g. at a `-` or `_` the matcher would not
      accept as a separator -- but never in *fewer*: it cannot fail to
      expose T as a standalone run wherever the pattern's `^` boundary is
      actually satisfied. Over-splitting only produces extra, harmless
      candidate rules (`#matchesRuleCondition` still rejects them); under-
      splitting is what would be unsound, and cannot happen here.

    Every candidate this reasoning accepts is still only a *candidate*:
    `#matchesRuleCondition` re-runs the unmodified `CompiledUrlFilter` match
    against every rule `getCandidateRules` returns, so an over-inclusive
    bucket (e.g. `ads` embedded in `pre-ads-track` when the rule requires
    `/ads/track`) costs an extra check, never a wrong decision.
    `src/main/extensions/dnr/tests/index-equivalence.test.ts`'s "token-index
    vectors" `describe` block exercises exactly these boundary kinds (a
    literal-bounded token, a left-anchor-bounded token, an unbounded token
    that must stay generic and still match embedded, a case-sensitive
    token, and a dynamic-rule add/remove), each checked both for
    indexed/unindexed parity and for the actual match/no-match decision
    Chrome's `urlFilter` semantics require; its gated uBOL run adds over
    5,000 requests, including URLs synthesized from the loaded rulesets'
    own `urlFilter` patterns with randomized surrounding text, so the
    parity check exercises the real ruleset's own token buckets, not only
    hand-picked vectors.

    **Measured effect**: of uBOL's default rulesets' 7,143 rules with no
    domain-shaped condition (patch 10's generic list), 6,748 (94.5%) get a
    sound token and move to the token index; 395 stay generic (of uBOL's
    current default rulesets, all 395 for lacking any bounded token of at
    least 3 characters -- e.g. a bare wildcard or a pattern whose only
    literal is under 3 characters -- rather than for being `regexFilter`,
    which this ruleset build happens not to use in its default-enabled
    sets, though the code path still exists for one that does). See
    `src/main/extensions/dnr/README.md`'s performance paragraph for the
    resulting median/p99 change.

12. **Host-permission gating, reinstated as a caller-supplied predicate.**
    Patch 8 dropped `RequestDetails#canExtensionModify` and
    `RequestEvaluator#isRuleActionAllowed` entirely, because Firefox
    computes them from a live `Extension` object this package has no
    equivalent of. Chrome's documented behavior still needs *some* per-
    request check: `block`, `allow`, `allowAllRequests` and `upgradeScheme`
    apply for any extension holding plain `declarativeNetRequest`, but
    `redirect` and `modifyHeaders` additionally require the extension to
    hold host permission for the request URL (and, when known, its
    initiator); `declarativeNetRequestWithHostAccess` requires host
    permission for every action type, not just those two. `RuleManager`
    gains an `actionAccess` field (`{hasHostAccess(requestURI,
    initiatorURI), requiresHostAccessForAllActions}`), defaulting to
    "always allowed" (`DEFAULT_ACTION_ACCESS`) so an engine whose caller
    never calls the registry's new `setActionAccess` matches exactly as it
    did before this patch -- every existing test in this package's suite
    depends on that default and none of them call `setActionAccess`.
    `RequestEvaluator#isActionAllowed` (new) checks it inside
    `#collectMatchInRuleset`, per candidate rule, before the rule is
    accepted into `matchedModifyHeadersRules` or considered for
    `matchedRule` -- not as a filter on `evaluateRequest`'s return value,
    because by the time that function returns, a losing `block`/`redirect`/
    `upgradeScheme` candidate from a disqualified extension is already
    discarded (`evaluateRequest` keeps only the single precedence winner
    for those action types); gating during collection instead means a rule
    this disqualifies is treated as though it never matched at all, so
    precedence naturally falls through to the next candidate, the same
    outcome Chrome's own per-candidate check produces. This package still
    does not decide *whether an extensionId holds `declarativeNetRequest`
    at all* -- only what its `actionAccess` predicate says about a specific
    request, once the caller has already decided the extension belongs in
    this engine. `src/main/extensions/dnr/host-permissions.ts` is the
    match-pattern matcher Orivon's own wiring builds `hasHostAccess`
    predicates from; it is a plain caller of this patch's public surface,
    not part of the vendored port.

13. **`RequestEvaluator#matchesRuleCondition`'s `requestDomains`/
    `excludedRequestDomains` checks now guard on `this.req.allRequestDomains`
    being set, the same way the `initiatorDomains`/`excludedInitiatorDomains`
    checks immediately below them already did.** Bug, not a behavioral
    port decision: `RequestDetails`'s constructor sets `allRequestDomains` to
    `''` (falsy, but not an array) when `requestURI.hostname` is empty --
    `data:`, `blob:`, `about:` and `javascript:` URLs all have an empty
    hostname. Upstream's initiator-side checks already handle
    `allInitiatorDomains` being falsy this way (an initiator legitimately can
    be absent, e.g. a top-level navigation), but the request-side checks had
    no equivalent guard, so `#matchesDomains(cond.requestDomains, '')` called
    `''.some(...)` and threw `TypeError: targetDomains.some is not a
    function`. Firefox's own `NetworkIntegration` never hands DNR a
    non-network-scheme request, so this path is unreachable there; Orivon's
    `dnr-webrequest.ts` registers on `<all_urls>` and does reach it, for any
    rule with `requestDomains`/`excludedRequestDomains` -- a condition
    uBlock Origin Lite's default rulesets put on thousands of rules. Fixed
    the same way upstream already guards the initiator side: a
    `requestDomains` condition fails to match (rather than throwing) when
    the request's own domain cannot be determined, and an
    `excludedRequestDomains` condition does not exclude in that case either.
    `src/main/extensions/dnr/tests/domain-conditions.test.ts`'s hostless-URL
    cases are the regression test.

14. **`RuleValidator` rejects `condition.responseHeaders`/
    `excludedResponseHeaders` and the deprecated `condition.domains`/
    `excludedDomains` aliases, with a message naming the field -- not present
    upstream, since Firefox's own `declarative_net_request.json` (this
    package's `schema/`) has none of the three: no Firefox implementation
    exists to port.** Before this patch, `RuleCondition`'s constructor
    silently dropped any condition field it does not explicitly assign
    (unchanged upstream behavior, kept for every field this port still does
    not recognize), which for these four fields means a rule matches every
    request the field was meant to narrow -- e.g. a `responseHeaders`
    condition meant to block only when a response carries a specific header
    would block unconditionally. uBlock Origin Lite's own default
    `ublock-filters.json` carries several `condition.responseHeaders` rules,
    so this is not a hypothetical shape. Rejecting at validation, the same
    place every other condition constraint in this file is enforced, turns
    that silent over-match into a clear, caller-visible error instead
    (`vendor/firefox-dnr/src/extension-dnr.mjs`'s new
    `#checkCondUnsupportedFields`). Because `RuleValidator#addRules` already
    skips only the one rule a check rejects (`continue`, not a hard stop),
    this costs a static ruleset nothing beyond the rejected rules themselves
    -- but see the accompanying `src/main/extensions/dnr/dnr-engine.ts`
    change below: its `applyEnabledStaticRulesets` used to treat *any*
    validation failure as fatal to the whole `setStaticRulesets` call
    (`validateOrThrow`'s `getFailures().length` throw), which this patch
    would otherwise turn into "uBOL's whole `ublock-filters` ruleset fails
    to load" over six rejected rules out of 5,509. `dnr-engine.ts` now uses
    a separate `validateStaticRuleset` for the static-ruleset path that
    keeps the (already per-rule-filtered) validated subset instead, matching
    Chrome's own documented behavior of dropping an invalid static rule
    without failing the rest of the ruleset; `updateDynamicRules`/
    `updateSessionRules` keep the original all-or-nothing `validateOrThrow`,
    matching Chrome's transactional contract for those two calls.
    `src/main/extensions/dnr/tests/rule-management.test.ts`'s "unsupported
    condition fields" describe block and
    `src/main/extensions/dnr/tests/real-ruleset-safety.test.ts` (gated on
    `ORIVON_DNR_PERF`, loads uBOL's actual default rulesets) are the
    regression tests. `topDomains`/`excludedTopDomains`, seen in uBOL's
    `rulesets/regex/*.json`, were investigated and are not a real
    `chrome.declarativeNetRequest` field: uBOL's own `ruleset-manager.js`
    (`if (condition.topDomains) { continue }`) strips any rule carrying it
    before that ruleset is ever loaded via `rule_resources` or handed to
    `chrome.declarativeNetRequest`, and `rulesets/regex/` itself is not
    referenced by any `rule_resources` entry in uBOL's manifest -- it is
    uBOL's own intermediate representation from parsing uBlock filter
    syntax, never a wire shape this engine needs to accept.

Nothing else changed: class/function bodies, the top-of-file design comment,
and every doc comment not touched by a patch above are upstream's own words,
reformatted only where ESLint-style (`let`→`const` where safe, semicolons
dropped) to match this repository's own source everywhere the meaning did
not change.

## Native-code check

`grep -rn "child_process\|require(['\"]net['\"]\|spawn(" vendor/firefox-dnr` returns
nothing; the engine is pure JavaScript (`URL`, `RegExp`, `Map`/`Set`/`WeakMap`
only).
