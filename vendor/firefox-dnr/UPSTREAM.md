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
- Host-permission gating (`canExtensionModify`, `hasBlockPermission`,
  `RequestDetails#canExtensionModify`, `RequestEvaluator#isRuleActionAllowed`):
  whether an extension is *allowed* to act on a given request is a broker/
  permission concern layered above `evaluate()`, not part of rule matching.
  `evaluate()` always matches as if the calling extension holds full
  `declarativeNetRequest` + host permissions; the caller is expected to have
  already refused anything it should not have reached this engine at all.

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
   they gated was already dead code.

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

Nothing else changed: class/function bodies, the top-of-file design comment,
and every doc comment not touched by a patch above are upstream's own words,
reformatted only where ESLint-style (`let`→`const` where safe, semicolons
dropped) to match this repository's own source everywhere the meaning did
not change.

## Native-code check

`grep -rn "child_process\|require(['\"]net['\"]\|spawn(" vendor/firefox-dnr` returns
nothing; the engine is pure JavaScript (`URL`, `RegExp`, `Map`/`Set`/`WeakMap`
only).
