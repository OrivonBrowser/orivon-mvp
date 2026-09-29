/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

// Ported from ExtensionDNR.sys.mjs. vendor/firefox-dnr/UPSTREAM.md lists every
// patch by number; the comments below cite the numbers that apply at each
// site. Dropped entirely (not patched, removed): NetworkIntegration and its
// webRequest/ChannelWrapper glue, the on-disk rule store
// (ExtensionDNRStore.sys.mjs), and manifest validation -- wiring this engine
// into a session's webRequest is a later package (see
// src/main/extensions/dnr/README.md). Firefox's own permission checks
// (canExtensionModify, hasBlockPermission) were dropped with them (patch 8)
// and later reinstated, driven by a caller-supplied predicate instead of a
// live Extension object (patch 12).
//
// Each extension that uses DNR has one RuleManager. All registered
// RuleManagers are checked whenever a network request occurs. Individual
// extensions may occasionally modify their rules (e.g. via updateSessionRules).
//
// Short version:
// Find the highest-priority rule that matches the given request. If the
// request is not canceled, all matching allowAllRequests and modifyHeaders
// actions are returned.
//
// Longer version:
// Unless stated otherwise, the explanation below describes the behavior within
// an extension.
// An extension can specify rules, optionally in multiple rulesets. The ability
// to have multiple ruleset exists to support bulk updates of rules. Rulesets
// are NOT independent - rules from different rulesets can affect each other.
//
// When multiple rules match, the order between rules are defined as follows:
// - Ruleset precedence: session > dynamic > static (order from manifest.json).
// - Rules in ruleset precedence: ordered by rule.id, lowest (numeric) ID first.
// - Across all rules+rulesets: highest rule.priority (default 1) first,
//                              action precedence if rule priority are the same.
//
// The primary documented way for extensions to describe precedence is by
// specifying rule.priority. Between same-priority rules, their precedence is
// dependent on the rule action. The ruleset/rule ID precedence is only used to
// have a defined ordering if multiple rules have the same priority+action.
//
// Rule actions have the following order of precedence and meaning:
// - "allow" can be used to ignore other same-or-lower-priority rules.
// - "allowAllRequests" (for main_frame / sub_frame resourceTypes only) has the
//      same effect as allow, but also applies to (future) subresource loads in
//      the document (including descendant frames) generated from the request.
// - "block" cancels the matched request.
// - "upgradeScheme" upgrades the scheme of the request.
// - "redirect" redirects the request.
// - "modifyHeaders" rewrites request/response headers.
//
// The matched rules are evaluated in two passes:
// 1. findMatchingRules():
//    Find the highest-priority rule(s), and choose the action with the highest
//    precedence (across all rulesets, any action except modifyHeaders).
//    This also accounts for any allowAllRequests from an ancestor frame.
//
// 2. getMatchingModifyHeadersRules():
//    Find matching rules with the "modifyHeaders" action, minus ignored rules.
//    Reaching this step implies that the request was not canceled, so either
//    the first step did not yield a rule, or the rule action is "allow" or
//    "allowAllRequests" (i.e. ignore same-or-lower-priority rules).
//
// The above describes the evaluation within one extension. When a sequence of
// (multiple) extensions is given, they may return conflicting actions in the
// first pass. This is resolved by choosing the action with the following order
// of precedence, in RequestEvaluator.evaluateRequest():
//  - block
//  - redirect / upgradeScheme
//  - allow / allowAllRequests

import { ExtensionError, DefaultWeakMap } from '../adapters/dnr-errors.mjs'
import { newURI, applyQueryTransform, applyURLTransform } from '../adapters/dnr-uri.mjs'
import { getBaseDomain } from '../adapters/dnr-domain.mjs'
import { ExtensionDNRLimits } from './dnr-limits.mjs'

// Ruleset precedence: session > dynamic > static (order from manifest.json).
const PRECEDENCE_SESSION_RULESET = 1
const PRECEDENCE_DYNAMIC_RULESET = 2
const PRECEDENCE_STATIC_RULESETS_BASE = 3

// The RuleCondition class represents a rule's "condition" type as described in
// schemas/declarative_net_request.json. This class exists to allow the JS
// engine to use one Shape for all Rule instances.
class RuleCondition {
  #compiledUrlFilter
  #compiledRegexFilter

  constructor(cond) {
    this.urlFilter = cond.urlFilter
    this.regexFilter = cond.regexFilter
    this.isUrlFilterCaseSensitive = cond.isUrlFilterCaseSensitive
    this.initiatorDomains = cond.initiatorDomains
    this.excludedInitiatorDomains = cond.excludedInitiatorDomains
    this.requestDomains = cond.requestDomains
    this.excludedRequestDomains = cond.excludedRequestDomains
    this.resourceTypes = cond.resourceTypes
    this.excludedResourceTypes = cond.excludedResourceTypes
    this.requestMethods = cond.requestMethods
    this.excludedRequestMethods = cond.excludedRequestMethods
    this.domainType = cond.domainType
    this.tabIds = cond.tabIds
    this.excludedTabIds = cond.excludedTabIds
  }

  // See CompiledUrlFilter for documentation.
  urlFilterMatches(requestDataForUrlFilter) {
    if (!this.#compiledUrlFilter) {
      // eslint-disable-next-line no-use-before-define
      this.#compiledUrlFilter = new CompiledUrlFilter(
        this.urlFilter,
        this.isUrlFilterCaseSensitive
      )
    }
    return this.#compiledUrlFilter.matchesRequest(requestDataForUrlFilter)
  }

  // Used for testing regexFilter matches in RequestEvaluator.#matchesRuleCondition
  // and to get the redirect URL from regexSubstitution in applyRegexSubstitution.
  getCompiledRegexFilter() {
    return this.#compiledRegexFilter
  }

  // RuleValidator compiles regexFilter before this Rule class is instantiated.
  // To avoid unnecessarily compiling it again, the result is assigned here.
  setCompiledRegexFilter(compiledRegexFilter) {
    this.#compiledRegexFilter = compiledRegexFilter
  }
}

export class Rule {
  constructor(rule) {
    this.id = rule.id
    this.priority = rule.priority
    this.condition = new RuleCondition(rule.condition)
    this.action = rule.action
  }

  // The precedence of rules within an extension. This method is frequently
  // used during the first pass of the RequestEvaluator.
  actionPrecedence() {
    switch (this.action.type) {
      case 'allow':
        return 1 // Highest precedence.
      case 'allowAllRequests':
        return 2
      case 'block':
        return 3
      case 'upgradeScheme':
        return 4
      case 'redirect':
        return 5
      case 'modifyHeaders':
        return 6
      default:
        throw new Error(`Unexpected action type: ${this.action.type}`)
    }
  }

  isAllowOrAllowAllRequestsAction() {
    const type = this.action.type
    return type === 'allow' || type === 'allowAllRequests'
  }
}

// Patch 10 (UPSTREAM.md): a per-Ruleset candidate index for
// #collectMatchInRuleset, not present upstream (Firefox's own engine also
// tests every rule in the ruleset, per this file's top comment). Added
// because Orivon runs this matcher in the main process for every network
// request, where a full scan of an 18,000-rule ad-block ruleset costs
// low-single-digit milliseconds per request (measured in
// src/main/extensions/dnr/tests/perf.test.ts). The index only narrows which
// rules #matchesRuleCondition runs against; every candidate it returns is
// still tested by that same, unmodified method, so it cannot change which
// rule wins, only how many are tested. src/main/extensions/dnr/README.md's
// Design notes has the equivalence argument this relies on.

/** Set false only by tests, to compare indexed and unindexed evaluation. */
let ruleIndexEnabled = true

// A urlFilter of exactly "||<domain>^" (nothing after the "^") or
// "||<domain>/..." can only match a request whose host is <domain> or a
// subdomain of it: CompiledUrlFilter's domain anchors are computed from the
// URL's host only (#getDomainAnchors), and both "^" as the pattern's last
// character and "/" force a label boundary immediately after <domain> ("."
// is not a "^" separator character, so "||example.com^" cannot match
// "example.com.evil.net", and "m" is not one either, so it cannot match
// "example.community"). A bare "||<domain>" with nothing after it, or a "^"
// that is not the pattern's last character (a one-character separator, not
// an anchor), does not have that guarantee and is left generic.
function extractIndexDomain(urlFilter) {
  if (urlFilter[0] !== '|' || urlFilter[1] !== '|') {
    return null
  }
  let cut = -1
  for (let i = 2; i < urlFilter.length; ++i) {
    const ch = urlFilter[i]
    if (ch === '^' || ch === '/') {
      cut = i
      break
    }
    if (ch === '*' || ch === '|') {
      // A wildcard or another anchor inside the domain part: not a plain
      // "||<domain>..." pattern.
      return null
    }
  }
  if (cut === -1 || (urlFilter[cut] === '^' && cut !== urlFilter.length - 1)) {
    return null
  }
  const domain = urlFilter.slice(2, cut)
  return DOMAIN_LABEL_RE.test(domain) ? domain.toLowerCase() : null
}

const DOMAIN_LABEL_RE = /^[a-z0-9]([a-z0-9-]*[a-z0-9])?(\.[a-z0-9]([a-z0-9-]*[a-z0-9])?)*$/i

/**
 * @param {Rule} rule
 * @returns {string[] | null} Domains this rule can be indexed under, or null
 *   if it belongs in the generic (always-tested) list.
 */
function indexDomainsForRule(rule) {
  const cond = rule.condition
  if (cond.requestDomains && cond.requestDomains.length) {
    // requestDomains is itself an exact precondition for a match (AND'ed
    // with any other condition on the same rule, including a urlFilter), so
    // it alone decides candidacy; a urlFilter on the same rule is still
    // fully re-checked by #matchesRuleCondition for every candidate.
    return cond.requestDomains
  }
  if (cond.urlFilter && !cond.regexFilter && !cond.isUrlFilterCaseSensitive) {
    const domain = extractIndexDomain(cond.urlFilter)
    if (domain) {
      return [domain]
    }
  }
  return null
}

// Patch 11 (UPSTREAM.md): a token index over the rules patch 10 leaves in
// the generic (always-tested) list, the technique uBlock Origin itself uses
// for the same problem. UPSTREAM.md's patch 11 entry has the full soundness
// argument; the short version: a token is only indexed when the pattern
// guarantees it appears in any matching URL as a whole maximal run of
// TOKEN_CHAR_RE characters, never as part of a longer run -- so a token
// lookup can never miss a rule that would otherwise have matched.
const TOKEN_MIN_LEN = 3
// The character class a token run is built from; see UPSTREAM.md patch 11
// for why its complement is provably a superset of the matcher's own
// separator class (CompiledUrlFilter's #regexIsSep), which is what makes an
// interior "^" boundary sound to index on too, not only literal characters.
const TOKEN_CHAR_RE = /[a-z0-9%]+/gi

/**
 * @param {string} urlFilter - a rule's condition.urlFilter, non-empty.
 * @param {boolean} isUrlFilterCaseSensitive
 * @returns {string[]} Every token in urlFilter's literal segments that is
 *   provably bounded on both sides -- by a "^" separator, an anchor ("||",
 *   "|" or a trailing "|"), or another literal character in the same
 *   segment -- so it is guaranteed to appear as a whole maximal alphanumeric
 *   (+"%") run in any URL the rule can match. Never bounded by "*" or by the
 *   pattern's own start/end without an anchor there. Left-to-right pattern
 *   order, deduplicated; empty if the pattern has no such token.
 */
function extractIndexTokenCandidates(urlFilter, isUrlFilterCaseSensitive) {
  let start = 0
  let end = urlFilter.length
  let isAnchorDomain = false
  let isAnchorLeft = false
  let isAnchorRight = false

  // Mirrors CompiledUrlFilter's own #initializeUrlFilter anchor/wildcard
  // trimming, so "bounded by an anchor" here means exactly what it means
  // there.
  if (urlFilter[0] === '|') {
    if (urlFilter[1] === '|') {
      start = 2
      isAnchorDomain = true
    } else {
      start = 1
      isAnchorLeft = true
    }
  }
  if (end > start && urlFilter[end - 1] === '|') {
    --end
    isAnchorRight = true
  }
  while (start < end && urlFilter[start] === '*') {
    ++start
    isAnchorLeft = false
  }
  while (end > start && urlFilter[end - 1] === '*') {
    --end
    isAnchorRight = false
  }

  let body = urlFilter.slice(start, end)
  if (!isUrlFilterCaseSensitive) {
    body = body.toLowerCase()
  }
  // "*" splits into the same parts CompiledUrlFilter matches independently
  // (a "*" boundary is never sound to index on: it can sit anywhere).
  const parts = body.split('*')
  const seen = new Set()
  const candidates = []

  parts.forEach((part, partIndex) => {
    const isFirstPart = partIndex === 0
    const isLastPart = partIndex === parts.length - 1
    // A part's own left/right edge is bounded only when it sits at the
    // pattern's true edge AND that edge carries an anchor.
    const partLeftBounded = isFirstPart && (isAnchorDomain || isAnchorLeft)
    const partRightBounded = isLastPart && isAnchorRight

    // "^" splits further within a part; each split point is itself a bound
    // (the matcher requires a separator character, or the trailing "^"
    // end-of-URL case, right there).
    const chunks = part.split('^')
    chunks.forEach((chunk, chunkIndex) => {
      const isFirstChunk = chunkIndex === 0
      const isLastChunk = chunkIndex === chunks.length - 1
      const chunkLeftBounded = !isFirstChunk || partLeftBounded
      const chunkRightBounded = !isLastChunk || partRightBounded

      TOKEN_CHAR_RE.lastIndex = 0
      let m
      while ((m = TOKEN_CHAR_RE.exec(chunk))) {
        const runStart = m.index
        const runEnd = runStart + m[0].length
        // A run not touching the chunk's own edge is already bounded by a
        // literal (non-token) character inside the chunk; one that does
        // touch the edge inherits that edge's boundedness.
        const leftOk = runStart > 0 || chunkLeftBounded
        const rightOk = runEnd < chunk.length || chunkRightBounded
        if (leftOk && rightOk && m[0].length >= TOKEN_MIN_LEN && !seen.has(m[0])) {
          seen.add(m[0])
          candidates.push(m[0])
        }
      }
    })
  })

  return candidates
}

/**
 * @param {Rule[]} rules
 * @returns {{
 *   byDomain: Map<string, object[]>,
 *   byToken: Map<string, object[]>,
 *   byTokenCS: Map<string, object[]>,
 *   generic: object[],
 * }}
 */
function buildRuleIndex(rules) {
  const byDomain = new Map()
  const generic = []
  // Two passes, same as uBlock Origin's own token index: the first collects
  // every rule's candidate tokens and how many rules share each one; the
  // second commits each rule to its least-common candidate, so a token
  // shared by few rules (and therefore a more selective bucket) is
  // preferred over one nearly every rule also happens to contain.
  const pendingByToken = [] // { rule, order, candidates }
  const pendingByTokenCS = []
  const freq = new Map() // "ci:"+token or "cs:"+token -> rule count

  rules.forEach((rule, order) => {
    const domains = indexDomainsForRule(rule)
    if (domains) {
      for (const domain of domains) {
        const key = domain.toLowerCase()
        let bucket = byDomain.get(key)
        if (!bucket) {
          bucket = []
          byDomain.set(key, bucket)
        }
        bucket.push({ rule, order })
      }
      return
    }
    const cond = rule.condition
    // A regexFilter rule's literal text (if any) is not what regexFilter
    // actually requires the URL to contain, so it is never indexed here --
    // UPSTREAM.md patch 10 already made this same call for the domain
    // index.
    if (cond.urlFilter && !cond.regexFilter) {
      const caseSensitive = !!cond.isUrlFilterCaseSensitive
      const candidates = extractIndexTokenCandidates(cond.urlFilter, caseSensitive)
      if (candidates.length) {
        const key = caseSensitive ? 'cs:' : 'ci:'
        for (const token of candidates) {
          const freqKey = key + token
          freq.set(freqKey, (freq.get(freqKey) ?? 0) + 1)
        }
        ;(caseSensitive ? pendingByTokenCS : pendingByToken).push({ rule, order, candidates, freqKey: key })
        return
      }
    }
    generic.push({ rule, order })
  })

  const byToken = new Map()
  const byTokenCS = new Map()
  for (const [pending, map] of [
    [pendingByToken, byToken],
    [pendingByTokenCS, byTokenCS],
  ]) {
    for (const { rule, order, candidates, freqKey } of pending) {
      let best = candidates[0]
      let bestFreq = freq.get(freqKey + best)
      for (let i = 1; i < candidates.length; ++i) {
        const token = candidates[i]
        const tokenFreq = freq.get(freqKey + token)
        if (tokenFreq < bestFreq) {
          best = token
          bestFreq = tokenFreq
        }
      }
      let bucket = map.get(best)
      if (!bucket) {
        bucket = []
        map.set(best, bucket)
      }
      bucket.push({ rule, order })
    }
  }

  return { byDomain, byToken, byTokenCS, generic }
}

class Ruleset {
  /**
   * @param {string} rulesetId - extension-defined ruleset ID.
   * @param {number} rulesetPrecedence
   * @param {Rule[]} rules - extension-defined rules
   * @param {Set<number> | null} disabledRuleIds
   * @param {RuleManager} ruleManager - owner of this ruleset.
   */
  constructor(rulesetId, rulesetPrecedence, rules, disabledRuleIds, ruleManager) {
    this.id = rulesetId
    this.rulesetPrecedence = rulesetPrecedence
    this.rules = rules
    this.disabledRuleIds = disabledRuleIds
    // For use by MatchedRule.
    this.ruleManager = ruleManager
  }

  #indexRulesRef
  #index

  /**
   * @param {string[] | null} requestDomains - the request's host and every
   *   parent domain (RequestDetails#allRequestDomains).
   * @param {RequestDataForUrlFilter} [requestDataForUrlFilter] - precomputed
   *   once per request (see that class); carries the token sets patch 11's
   *   index looks candidates up by.
   * @returns {Rule[]} A subset of |this.rules|, in the same relative order
   *   a full scan of |this.rules| would visit them in. Always a superset of
   *   the rules that can match: every rule not returned here is provably
   *   excluded by indexDomainsForRule's domain condition or
   *   extractIndexTokenCandidates's token condition, either of which
   *   #matchesRuleCondition would also have rejected.
   */
  getCandidateRules(requestDomains, requestDataForUrlFilter) {
    if (this.#indexRulesRef !== this.rules) {
      this.#index = buildRuleIndex(this.rules)
      this.#indexRulesRef = this.rules
    }
    const { byDomain, byToken, byTokenCS, generic } = this.#index
    if (!requestDomains || (byDomain.size === 0 && byToken.size === 0 && byTokenCS.size === 0)) {
      return this.rules
    }
    const seenOrder = new Set()
    const picked = []
    for (const entry of generic) {
      picked.push(entry)
      seenOrder.add(entry.order)
    }
    let matchedAny = false
    for (const domain of requestDomains) {
      const bucket = byDomain.get(domain)
      if (!bucket) {
        continue
      }
      matchedAny = true
      for (const entry of bucket) {
        if (!seenOrder.has(entry.order)) {
          seenOrder.add(entry.order)
          picked.push(entry)
        }
      }
    }
    if (requestDataForUrlFilter) {
      if (byToken.size) {
        for (const token of requestDataForUrlFilter.tokensLowerCase) {
          const bucket = byToken.get(token)
          if (!bucket) {
            continue
          }
          matchedAny = true
          for (const entry of bucket) {
            if (!seenOrder.has(entry.order)) {
              seenOrder.add(entry.order)
              picked.push(entry)
            }
          }
        }
      }
      if (byTokenCS.size) {
        for (const token of requestDataForUrlFilter.tokensAnyCase) {
          const bucket = byTokenCS.get(token)
          if (!bucket) {
            continue
          }
          matchedAny = true
          for (const entry of bucket) {
            if (!seenOrder.has(entry.order)) {
              seenOrder.add(entry.order)
              picked.push(entry)
            }
          }
        }
      }
    }
    if (!matchedAny) {
      return generic.map(entry => entry.rule)
    }
    picked.sort((a, b) => a.order - b.order)
    return picked.map(entry => entry.rule)
  }
}

// Patch 2 (vendor/firefox-dnr/UPSTREAM.md): applyQueryTransform and
// applyURLTransform moved to adapters/dnr-uri.mjs, which replaces
// nsIURIMutator with WHATWG URL.

/**
 * @param {MatchedRule} matchedRule - matched rule with a regexFilter
 *   condition and regexSubstitution action.
 * @param {URL} uri
 * @returns {URL} The new URL derived from the regexSubstitution combined with
 *   the capturing groups from regexFilter applied to the input uri.
 * @throws if the resulting URL is not a redirectable http(s) URL.
 */
function applyRegexSubstitution(matchedRule, uri) {
  const rule = matchedRule.rule
  const regexSubstitution = rule.action.redirect.regexSubstitution
  const compiledRegexFilter = rule.condition.getCompiledRegexFilter()
  // This method being called implies that regexFilter matched, so |matches|
  // is always non-null, i.e. an array of string/undefined values.
  const matches = compiledRegexFilter.exec(uri.href)

  const redirectUrl = regexSubstitution.replace(/\\(.)/g, (_, char) => {
    // #checkActionRedirect ensures that every \ is followed by a \ or digit.
    return char === '\\' ? char : matches[char] ?? ''
  })

  let redirectUri
  try {
    redirectUri = newURI(redirectUrl)
  } catch {
    throw new Error(
      `Extension ${matchedRule.ruleManager.extensionId} tried to redirect to an invalid URL: ${redirectUrl}`
    )
  }
  // Patch 5 (UPSTREAM.md): extension.checkLoadURI (a privileged-URI check
  // against the caller's principal) is replaced by a plain scheme allowlist,
  // matching declarative_net_request.json's own "redirect.url" format:"url"
  // restriction to http(s)/extension-page targets. Host-permission gating
  // (whether the extension may act on requestURI at all) is out of scope
  // for this engine -- see the README's Design notes.
  if (redirectUri.protocol !== 'http:' && redirectUri.protocol !== 'https:') {
    throw new Error(
      `Extension ${matchedRule.ruleManager.extensionId} may not redirect to: ${redirectUrl}`
    )
  }
  return redirectUri
}

/**
 * An urlFilter is a string pattern to match a canonical http(s) URL.
 * urlFilter matches anywhere in the string, unless an anchor is present:
 * - ||... ("Domain name anchor") - domain or subdomain starts with ...
 * - |... ("Left anchor") - URL starts with ...
 * - ...| ("Right anchor") - URL ends with ...
 *
 * Other than the anchors, the following special characters exist:
 * - ^ = end of URL, or any char except: alphanum _ - . % ("Separator")
 * - * = any number of characters ("Wildcard")
 *
 * Ambiguous cases (undocumented but actual Chrome behavior):
 * - Plain "||" is a domain name anchor, not left + empty + right anchor.
 * - "^" repeated at end of pattern: "^" matches end of URL only once.
 * - "^|" at end of pattern: "^" is allowed to match end of URL.
 *
 * Implementation details:
 * - CompiledUrlFilter's constructor (+#initializeUrlFilter) extracts the
 *   actual urlFilter and anchors, for matching against URLs later.
 * - RequestDataForUrlFilter class precomputes the URL / domain anchors to
 *   support matching more efficiently.
 * - CompiledUrlFilter's matchesRequest(request) checks whether the request is
 *   actually matched, using the precomputed information.
 *
 * The class was designed to minimize the number of string allocations during
 * request evaluation, because the matchesRequest method may be called very
 * often for every network request.
 */
class CompiledUrlFilter {
  #isUrlFilterCaseSensitive
  #urlFilterParts // = parts of urlFilter, minus anchors, split at "*".
  // isAnchorLeft and isAnchorDomain are mutually exclusive.
  #isAnchorLeft = false
  #isAnchorDomain = false
  #isAnchorRight = false
  #isTrailingSeparator = false // Whether urlFilter ends with "^".

  /**
   * @param {string} urlFilter - non-empty urlFilter
   * @param {boolean} [isUrlFilterCaseSensitive]
   */
  constructor(urlFilter, isUrlFilterCaseSensitive) {
    this.#isUrlFilterCaseSensitive = isUrlFilterCaseSensitive
    this.#initializeUrlFilter(urlFilter, isUrlFilterCaseSensitive)
  }

  #initializeUrlFilter(urlFilter, isUrlFilterCaseSensitive) {
    let start = 0
    let end = urlFilter.length

    // First, trim the anchors off urlFilter.
    if (urlFilter[0] === '|') {
      if (urlFilter[1] === '|') {
        start = 2
        this.#isAnchorDomain = true
        // ^ will not revert to false below, because "||*" is already rejected
        // by RuleValidator's #checkCondUrlFilterAndRegexFilter method.
      } else {
        start = 1
        this.#isAnchorLeft = true // may revert to false below.
      }
    }
    if (end > start && urlFilter[end - 1] === '|') {
      --end
      this.#isAnchorRight = true // may revert to false below.
    }

    // Skip unnecessary wildcards, and adjust meaningless anchors accordingly:
    // "|*" and "*|" are not effective anchors, they could have been omitted.
    while (start < end && urlFilter[start] === '*') {
      ++start
      this.#isAnchorLeft = false
    }
    while (end > start && urlFilter[end - 1] === '*') {
      --end
      this.#isAnchorRight = false
    }

    // Special-case the last "^", so that the matching algorithm can rely on
    // the simple assumption that a "^" in the filter matches exactly one char:
    // The "^" at the end of the pattern is specified to match either one char
    // as usual, or as an anchor for the end of the URL (i.e. zero characters).
    this.#isTrailingSeparator = urlFilter[end - 1] === '^'

    let urlFilterWithoutAnchors = urlFilter.slice(start, end)
    if (!isUrlFilterCaseSensitive) {
      urlFilterWithoutAnchors = urlFilterWithoutAnchors.toLowerCase()
    }
    this.#urlFilterParts = urlFilterWithoutAnchors.split('*')
  }

  /**
   * Tests whether |request| matches the urlFilter.
   *
   * @param {RequestDataForUrlFilter} requestDataForUrlFilter
   * @returns {boolean} Whether the condition matches the URL.
   */
  matchesRequest(requestDataForUrlFilter) {
    const url = requestDataForUrlFilter.getUrl(this.#isUrlFilterCaseSensitive)
    const domainAnchors = requestDataForUrlFilter.domainAnchors

    const urlFilterParts = this.#urlFilterParts

    const REAL_END_OF_URL = url.length - 1 // minus trailing "^"

    // atUrlIndex is the position after the most recently matched part.
    // If a match is not found, it is -1 and we should return false.
    let atUrlIndex = 0

    // The head always exists, potentially even an empty string.
    const head = urlFilterParts[0]
    if (this.#isAnchorLeft) {
      if (!this.#startsWithPart(head, url, 0)) {
        return false
      }
      atUrlIndex = head.length
    } else if (this.#isAnchorDomain) {
      atUrlIndex = this.#indexAfterDomainPart(head, url, domainAnchors)
    } else {
      atUrlIndex = this.#indexAfterPart(head, url, 0)
    }

    let previouslyAtUrlIndex = 0
    for (let i = 1; i < urlFilterParts.length && atUrlIndex !== -1; ++i) {
      previouslyAtUrlIndex = atUrlIndex
      atUrlIndex = this.#indexAfterPart(urlFilterParts[i], url, atUrlIndex)
    }
    if (atUrlIndex === -1) {
      return false
    }
    if (atUrlIndex === url.length) {
      // We always append a "^" to the URL, so if the match is at the end of the
      // URL (REAL_END_OF_URL), only accept if the pattern ended with a "^".
      return this.#isTrailingSeparator
    }
    if (!this.#isAnchorRight || atUrlIndex === REAL_END_OF_URL) {
      // Either not interested in the end, or already at the end of the URL.
      return true
    }

    // #isAnchorRight is true but we are not at the end of the URL.
    // Backtrack once, to retry the last pattern (tail) with the end of the URL.

    const tail = urlFilterParts[urlFilterParts.length - 1]
    // The expected offset where the tail should be located.
    const expectedTailIndex = REAL_END_OF_URL - tail.length
    // If #isTrailingSeparator is true, then accept the URL's trailing "^".
    const expectedTailIndexPlus1 = expectedTailIndex + 1
    if (urlFilterParts.length === 1) {
      if (this.#isAnchorLeft) {
        // If matched, we would have returned at the REAL_END_OF_URL checks.
        return false
      }
      if (this.#isAnchorDomain) {
        // The tail must be exactly at one of the domain anchors.
        return (
          (domainAnchors.includes(expectedTailIndex) &&
            this.#startsWithPart(tail, url, expectedTailIndex)) ||
          (this.#isTrailingSeparator &&
            domainAnchors.includes(expectedTailIndexPlus1) &&
            this.#startsWithPart(tail, url, expectedTailIndexPlus1))
        )
      }
      // head has no left/domain anchor, fall through.
    }
    // The tail is not left/domain anchored, accept it as long as it did not
    // overlap with an already-matched part of the URL.
    return (
      (expectedTailIndex > previouslyAtUrlIndex &&
        this.#startsWithPart(tail, url, expectedTailIndex)) ||
      (this.#isTrailingSeparator &&
        expectedTailIndexPlus1 > previouslyAtUrlIndex &&
        this.#startsWithPart(tail, url, expectedTailIndexPlus1))
    )
  }

  // Whether a character should match "^" in an urlFilter.
  // The "match end of URL" meaning of "^" is covered by #isTrailingSeparator.
  static #regexIsSep = /[^A-Za-z0-9_\-.%]/

  #matchPartAt(part, url, urlIndex, sepStart) {
    if (sepStart === -1) {
      // Fast path.
      return url.startsWith(part, urlIndex)
    }
    if (urlIndex + part.length > url.length) {
      return false
    }
    for (let i = 0; i < part.length; ++i) {
      const partChar = part[i]
      const urlChar = url[urlIndex + i]
      if (
        partChar !== urlChar &&
        (partChar !== '^' || !CompiledUrlFilter.#regexIsSep.test(urlChar))
      ) {
        return false
      }
    }
    return true
  }

  #startsWithPart(part, url, urlIndex) {
    const sepStart = part.indexOf('^')
    return this.#matchPartAt(part, url, urlIndex, sepStart)
  }

  #indexAfterPart(part, url, urlIndex) {
    const sepStart = part.indexOf('^')
    if (sepStart === -1) {
      // Fast path.
      const i = url.indexOf(part, urlIndex)
      return i === -1 ? i : i + part.length
    }
    const maxUrlIndex = url.length - part.length
    for (let i = urlIndex; i <= maxUrlIndex; ++i) {
      if (this.#matchPartAt(part, url, i, sepStart)) {
        return i + part.length
      }
    }
    return -1
  }

  #indexAfterDomainPart(part, url, domainAnchors) {
    const sepStart = part.indexOf('^')
    for (const offset of domainAnchors) {
      if (this.#matchPartAt(part, url, offset, sepStart)) {
        return offset + part.length
      }
    }
    return -1
  }
}

// See CompiledUrlFilter for documentation of RequestDataForUrlFilter.
class RequestDataForUrlFilter {
  #tokensLowerCase
  #tokensAnyCase

  /** @param {string} requestURIspec - The URL to match against. */
  constructor(requestURIspec) {
    // "^" is appended, see CompiledUrlFilter's #initializeUrlFilter.
    this.urlAnyCase = requestURIspec + '^'
    this.urlLowerCase = this.urlAnyCase.toLowerCase()
    // For "||..." (Domain name anchor): where (sub)domains start in the URL.
    this.domainAnchors = this.#getDomainAnchors(this.urlAnyCase)
  }

  getUrl(isUrlFilterCaseSensitive) {
    return isUrlFilterCaseSensitive ? this.urlAnyCase : this.urlLowerCase
  }

  // Patch 11 (UPSTREAM.md): the request's URL, tokenised into maximal
  // TOKEN_CHAR_RE runs, for Ruleset#getCandidateRules's token index. Lazy
  // and memoized: computed at most once per request (this object is built
  // once per RequestDetails, reused across every ruleset/extension the
  // request is evaluated against), and never at all for a request that
  // never reaches a ruleset with a non-empty token index.
  get tokensLowerCase() {
    return (this.#tokensLowerCase ??= RequestDataForUrlFilter.#tokenize(this.urlLowerCase))
  }

  get tokensAnyCase() {
    return (this.#tokensAnyCase ??= RequestDataForUrlFilter.#tokenize(this.urlAnyCase))
  }

  /** @param {string} url @returns {Set<string>} */
  static #tokenize(url) {
    const tokens = new Set()
    TOKEN_CHAR_RE.lastIndex = 0
    let m
    while ((m = TOKEN_CHAR_RE.exec(url))) {
      tokens.add(m[0])
    }
    return tokens
  }

  #getDomainAnchors(url) {
    let hostStart = url.indexOf('://') + 3
    const hostEnd = url.indexOf('/', hostStart)
    const userpassEnd = url.lastIndexOf('@', hostEnd) + 1
    if (userpassEnd) {
      hostStart = userpassEnd
    }
    const host = url.slice(hostStart, hostEnd)
    const domainAnchors = [hostStart]
    let offset = 0
    // Find all offsets after ".". If not found, -1 + 1 = 0, and the loop ends.
    while ((offset = host.indexOf('.', offset) + 1)) {
      domainAnchors.push(hostStart + offset)
    }
    return domainAnchors
  }
}

function compileRegexFilter(regexFilter, isUrlFilterCaseSensitive) {
  return new RegExp(regexFilter, isUrlFilterCaseSensitive ? '' : 'i')
}

// Patch 6 (UPSTREAM.md): ModifyHeadersBase/ModifyRequestHeaders/
// ModifyResponseHeaders no longer mutate a live ChannelWrapper (Orivon's
// engine does not hold one -- see DnrDecision in dnr-engine.ts). They collect
// header operations into `this.ops`, in the same precedence order the
// original applied them in, for a caller to apply to the real request. The
// #checkHostHeader permission check (host-permission gating) is dropped along
// with the other permission checks (see this file's top comment).
class ModifyHeadersBase {
  // Map<string,MatchedRule> - The first MatchedRule that modified the header.
  // After modifying a header, it cannot be modified further, with the
  // exception of "append", provided that they are from the same extension.
  #alreadyModifiedMap = new Map()
  // Set<string> - headers allowed to be modified with "append" despite having
  // been modified. Allowed for "set"/"append", not for "remove".
  #appendStillAllowed = new Set()

  ops = []

  /** @param {MatchedRule} _matchedRule @returns {object[]} */
  headerActionsFor(_matchedRule) {
    throw new Error('Not implemented.')
  }

  /** @param {MatchedRule[]} matchedRules */
  applyModifyHeaders(matchedRules) {
    for (const matchedRule of matchedRules) {
      for (const headerAction of this.headerActionsFor(matchedRule)) {
        const { header: name, operation, value } = headerAction
        if (!this.#isOperationAllowed(name, operation, matchedRule)) {
          continue
        }
        if (operation === 'set' || operation === 'append') {
          this.ops.push({ header: name, operation, value })
          this.#appendStillAllowed.add(name)
        } else if (operation === 'remove') {
          this.ops.push({ header: name, operation: 'remove', value: '' })
          // Removal is final, so we don't add to #appendStillAllowed.
        }
        this.#alreadyModifiedMap.set(name, matchedRule)
      }
    }
  }

  #isOperationAllowed(name, operation, matchedRule) {
    const modifiedBy = this.#alreadyModifiedMap.get(name)
    if (!modifiedBy) {
      return true
    }
    return (
      operation === 'append' &&
      this.#appendStillAllowed.has(name) &&
      matchedRule.ruleManager === modifiedBy.ruleManager
    )
  }

  // kName should already be in lower case.
  isHeaderNameEqual(name, kName) {
    return name.length === kName.length && name.toLowerCase() === kName
  }
}

class ModifyRequestHeaders extends ModifyHeadersBase {
  static maybeApplyModifyHeaders(matchedRules) {
    const filtered = matchedRules.filter(mr => {
      const action = mr.rule.action
      return action.type === 'modifyHeaders' && action.requestHeaders?.length
    })
    if (!filtered.length) {
      return []
    }
    const applier = new ModifyRequestHeaders()
    applier.applyModifyHeaders(filtered)
    return applier.ops
  }

  /** @param {MatchedRule} matchedRule */
  headerActionsFor(matchedRule) {
    return matchedRule.rule.action.requestHeaders
  }
}

class ModifyResponseHeaders extends ModifyHeadersBase {
  static maybeApplyModifyHeaders(matchedRules) {
    const filtered = matchedRules.filter(mr => {
      const action = mr.rule.action
      return action.type === 'modifyHeaders' && action.responseHeaders?.length
    })
    if (!filtered.length) {
      return []
    }
    const applier = new ModifyResponseHeaders()
    applier.applyModifyHeaders(filtered)
    return applier.ops
  }

  headerActionsFor(matchedRule) {
    return matchedRule.rule.action.responseHeaders
  }
}

class RuleValidator {
  constructor(alreadyValidatedRules, { isSessionRuleset = false } = {}) {
    this.rulesMap = new Map(alreadyValidatedRules.map(r => [r.id, r]))
    this.failures = []
    this.isSessionRuleset = isSessionRuleset
  }

  /**
   * Deserializes a Rule instance from a plain object, as produced by
   * JSON.parse of a previously-serialized Rule.
   *
   * @param {object} rule
   * @returns {Rule}
   */
  static deserializeRule(rule) {
    const newRule = new Rule(rule)
    if (newRule.condition.regexFilter) {
      newRule.condition.setCompiledRegexFilter(
        compileRegexFilter(
          newRule.condition.regexFilter,
          newRule.condition.isUrlFilterCaseSensitive
        )
      )
    }
    return newRule
  }

  removeRuleIds(ruleIds) {
    for (const ruleId of ruleIds) {
      this.rulesMap.delete(ruleId)
    }
  }

  /**
   * @param {object[]} rules - A list of objects that adhere to the Rule type
   *    from declarative_net_request.json.
   */
  addRules(rules) {
    for (const rule of rules) {
      if (this.rulesMap.has(rule.id)) {
        this.#collectInvalidRule(rule, `Duplicate rule ID: ${rule.id}`)
        continue
      }
      // declarative_net_request.json defines basic types, such as the expected
      // object properties and (primitive) type. Trivial constraints such as
      // minimum array lengths are also expressed in the schema.
      // Anything more complex is validated here. In particular, constraints
      // involving multiple properties (e.g. mutual exclusiveness).
      if (
        !this.#checkCondResourceTypes(rule) ||
        !this.#checkCondRequestMethods(rule) ||
        !this.#checkCondTabIds(rule) ||
        !this.#checkCondUrlFilterAndRegexFilter(rule) ||
        !this.#checkAction(rule)
      ) {
        continue
      }

      const newRule = new Rule(rule)
      // #lastCompiledRegexFilter is set if regexFilter is set, and null
      // otherwise by the above call to #checkCondUrlFilterAndRegexFilter().
      if (this.#lastCompiledRegexFilter) {
        newRule.condition.setCompiledRegexFilter(this.#lastCompiledRegexFilter)
      }

      this.rulesMap.set(rule.id, newRule)
    }
  }

  // #checkCondUrlFilterAndRegexFilter() compiles the regexFilter to check its
  // validity. To avoid having to compile it again when the Rule (RuleCondition)
  // is constructed, we temporarily cache the result.
  #lastCompiledRegexFilter

  // Checks: resourceTypes & excludedResourceTypes
  #checkCondResourceTypes(rule) {
    const { resourceTypes, excludedResourceTypes } = rule.condition
    if (this.#hasOverlap(resourceTypes, excludedResourceTypes)) {
      this.#collectInvalidRule(
        rule,
        'resourceTypes and excludedResourceTypes should not overlap'
      )
      return false
    }
    if (rule.action.type === 'allowAllRequests') {
      if (!resourceTypes) {
        this.#collectInvalidRule(
          rule,
          'An allowAllRequests rule must have a non-empty resourceTypes array'
        )
        return false
      }
      if (resourceTypes.some(r => r !== 'main_frame' && r !== 'sub_frame')) {
        this.#collectInvalidRule(
          rule,
          'An allowAllRequests rule may only include main_frame/sub_frame in resourceTypes'
        )
        return false
      }
    }
    return true
  }

  // Checks: requestMethods & excludedRequestMethods
  #checkCondRequestMethods(rule) {
    const { requestMethods, excludedRequestMethods } = rule.condition
    if (this.#hasOverlap(requestMethods, excludedRequestMethods)) {
      this.#collectInvalidRule(
        rule,
        'requestMethods and excludedRequestMethods should not overlap'
      )
      return false
    }
    const isInvalidRequestMethod = method => method.toLowerCase() !== method
    if (
      requestMethods?.some(isInvalidRequestMethod) ||
      excludedRequestMethods?.some(isInvalidRequestMethod)
    ) {
      this.#collectInvalidRule(rule, 'request methods must be in lower case')
      return false
    }
    return true
  }

  // Checks: tabIds & excludedTabIds
  #checkCondTabIds(rule) {
    const { tabIds, excludedTabIds } = rule.condition

    if ((tabIds || excludedTabIds) && !this.isSessionRuleset) {
      this.#collectInvalidRule(
        rule,
        'tabIds and excludedTabIds can only be specified in session rules'
      )
      return false
    }

    if (this.#hasOverlap(tabIds, excludedTabIds)) {
      this.#collectInvalidRule(rule, 'tabIds and excludedTabIds should not overlap')
      return false
    }
    return true
  }

  static #regexNonASCII = /[^\x00-\x7F]/
  static #regexDigitOrBackslash = /^[0-9\\]$/

  // Checks: urlFilter & regexFilter
  #checkCondUrlFilterAndRegexFilter(rule) {
    const { urlFilter, regexFilter } = rule.condition

    this.#lastCompiledRegexFilter = null

    const checkEmptyOrNonASCII = (str, prop) => {
      if (!str) {
        this.#collectInvalidRule(rule, `${prop} should not be an empty string`)
        return false
      }
      // Non-ASCII in URLs are always encoded in % (or punycode in domains).
      if (RuleValidator.#regexNonASCII.test(str)) {
        this.#collectInvalidRule(rule, `${prop} should not contain non-ASCII characters`)
        return false
      }
      return true
    }
    if (urlFilter != null) {
      if (regexFilter != null) {
        this.#collectInvalidRule(rule, 'urlFilter and regexFilter are mutually exclusive')
        return false
      }
      if (!checkEmptyOrNonASCII(urlFilter, 'urlFilter')) {
        return false
      }
      if (urlFilter.startsWith('||*')) {
        // Rejected because Chrome does too. '||*' is equivalent to '*'.
        this.#collectInvalidRule(rule, "urlFilter should not start with '||*'")
        return false
      }
    } else if (regexFilter != null) {
      if (!checkEmptyOrNonASCII(regexFilter, 'regexFilter')) {
        return false
      }
      try {
        this.#lastCompiledRegexFilter = compileRegexFilter(
          regexFilter,
          rule.condition.isUrlFilterCaseSensitive
        )
      } catch {
        this.#collectInvalidRule(rule, 'regexFilter is not a valid regular expression')
        return false
      }
    }
    return true
  }

  #checkAction(rule) {
    switch (rule.action.type) {
      case 'allow':
      case 'allowAllRequests':
      case 'block':
      case 'upgradeScheme':
        // These actions have no extra properties.
        break
      case 'redirect':
        return this.#checkActionRedirect(rule)
      case 'modifyHeaders':
        return this.#checkActionModifyHeaders(rule)
      default:
        // Other values are not possible because declarative_net_request.json
        // only accepts the above action types.
        throw new Error(`Unexpected action type: ${rule.action.type}`)
    }
    return true
  }

  #checkActionRedirect(rule) {
    const { url, extensionPath, transform, regexSubstitution } = rule.action.redirect ?? {}
    const hasExtensionPath = extensionPath != null
    const hasRegexSubstitution = regexSubstitution != null
    const redirectKeyCount = !!url + !!hasExtensionPath + !!transform + !!hasRegexSubstitution
    if (redirectKeyCount !== 1) {
      if (redirectKeyCount === 0) {
        this.#collectInvalidRule(
          rule,
          'A redirect rule must have a non-empty action.redirect object'
        )
        return false
      }
      // Side note: Chrome silently ignores excess keys, and skips validation
      // for ignored keys, in this order:
      // url > extensionPath > transform > regexSubstitution
      this.#collectInvalidRule(
        rule,
        'redirect.url, redirect.extensionPath, redirect.transform and redirect.regexSubstitution are mutually exclusive'
      )
      return false
    }

    if (hasExtensionPath && !extensionPath.startsWith('/')) {
      this.#collectInvalidRule(rule, "redirect.extensionPath should start with a '/'")
      return false
    }

    if (transform) {
      if (transform.query != null && transform.queryTransform) {
        this.#collectInvalidRule(
          rule,
          'redirect.transform.query and redirect.transform.queryTransform are mutually exclusive'
        )
        return false
      }
      // Most of the validation is done by applyURLTransform via WHATWG URL.
      // URL is not very strict, so we perform some extra checks here to
      // reject values that are not technically valid URLs.

      if (transform.port && /\D/.test(transform.port)) {
        this.#collectInvalidRule(
          rule,
          'redirect.transform.port should be empty or an integer'
        )
        return false
      }

      // Note: we don't verify whether transform.query starts with '/', because
      // Chrome does not require it either.

      if (transform.query && !transform.query.startsWith('?')) {
        this.#collectInvalidRule(
          rule,
          "redirect.transform.query should be empty or start with a '?'"
        )
        return false
      }
      if (transform.fragment && !transform.fragment.startsWith('#')) {
        this.#collectInvalidRule(
          rule,
          "redirect.transform.fragment should be empty or start with a '#'"
        )
        return false
      }
      try {
        const dummyURI = newURI('http://dummy')
        // applyURLTransform throws if |transform| is invalid, e.g. invalid
        // host, port, etc. -- see adapters/dnr-uri.mjs for the (looser) URL
        // equivalent of nsIURIMutator's validation.
        applyURLTransform(dummyURI, transform)
      } catch {
        this.#collectInvalidRule(
          rule,
          'redirect.transform does not describe a valid URL transformation'
        )
        return false
      }
    }

    if (hasRegexSubstitution) {
      if (!rule.condition.regexFilter) {
        this.#collectInvalidRule(
          rule,
          'redirect.regexSubstitution requires the regexFilter condition to be specified'
        )
        return false
      }
      let i = 0
      // i will be index after \. Loop breaks if not found (-1+1=0 = false).
      while ((i = regexSubstitution.indexOf('\\', i) + 1)) {
        const c = regexSubstitution[i++] // may be undefined if \ is at end.
        if (c === undefined || !RuleValidator.#regexDigitOrBackslash.test(c)) {
          this.#collectInvalidRule(
            rule,
            'redirect.regexSubstitution only allows digit or \\ after \\.'
          )
          return false
        }
      }
    }

    return true
  }

  #checkActionModifyHeaders(rule) {
    const { requestHeaders, responseHeaders } = rule.action
    if (!requestHeaders && !responseHeaders) {
      this.#collectInvalidRule(
        rule,
        'A modifyHeaders rule must have a non-empty requestHeaders or modifyHeaders list'
      )
      return false
    }

    const isValidModifyHeadersOp = ({ header, operation, value }) => {
      if (!header) {
        this.#collectInvalidRule(rule, 'header must be non-empty')
        return false
      }
      if (!value && (operation === 'append' || operation === 'set')) {
        this.#collectInvalidRule(rule, 'value is required for operations append/set')
        return false
      }
      if (value && operation === 'remove') {
        this.#collectInvalidRule(rule, 'value must not be provided for operation remove')
        return false
      }
      return true
    }
    if (
      (requestHeaders && !requestHeaders.every(isValidModifyHeadersOp)) ||
      (responseHeaders && !responseHeaders.every(isValidModifyHeadersOp))
    ) {
      return false
    }
    return true
  }

  // Conditions with a filter and an exclude-filter should reject overlapping
  // lists, because they can never simultaneously be true.
  #hasOverlap(arrayA, arrayB) {
    return arrayA && arrayB && arrayA.some(v => arrayB.includes(v))
  }

  #collectInvalidRule(rule, message) {
    this.failures.push({ rule, message })
  }

  getValidatedRules() {
    return Array.from(this.rulesMap.values())
  }

  getFailures() {
    return this.failures
  }
}

class RuleQuotaCounter {
  constructor(ruleLimitName) {
    this.ruleLimitName = ruleLimitName
    this.ruleLimitRemaining = ExtensionDNRLimits[this.ruleLimitName]
    this.regexRemaining = ExtensionDNRLimits.MAX_NUMBER_OF_REGEX_RULES
  }

  tryAddRules(rulesetId, rules) {
    if (rules.length > this.ruleLimitRemaining) {
      this.#throwQuotaError(rulesetId, 'rules', this.ruleLimitName)
    }
    let regexCount = 0
    for (const rule of rules) {
      if (rule.condition.regexFilter && ++regexCount > this.regexRemaining) {
        this.#throwQuotaError(rulesetId, 'regexFilter rules', 'MAX_NUMBER_OF_REGEX_RULES')
      }
    }

    // Update counters only when there are no quota errors.
    this.ruleLimitRemaining -= rules.length
    this.regexRemaining -= regexCount
  }

  #throwQuotaError(rulesetId, what, limitName) {
    if (this.ruleLimitName === 'GUARANTEED_MINIMUM_STATIC_RULES') {
      throw new ExtensionError(
        `Number of ${what} across all enabled static rulesets exceeds ${limitName} if ruleset "${rulesetId}" were to be enabled.`
      )
    }
    throw new ExtensionError(`Number of ${what} in ruleset "${rulesetId}" exceeds ${limitName}.`)
  }
}

/**
 * Compares two rules to determine the relative order of precedence.
 * Rules are only comparable if they are from the same extension!
 *
 * @param {Rule} ruleA
 * @param {Rule} ruleB
 * @param {Ruleset} rulesetA - the ruleset ruleA is part of.
 * @param {Ruleset} rulesetB - the ruleset ruleB is part of.
 * @returns {number} 0 if equal, <0 if ruleA before ruleB, >0 if ruleA after ruleB.
 */
function compareRule(ruleA, ruleB, rulesetA, rulesetB) {
  function cmpHighestNumber(a, b) {
    return a === b ? 0 : b - a
  }
  function cmpLowestNumber(a, b) {
    return a === b ? 0 : a - b
  }
  return (
    cmpHighestNumber(ruleA.priority, ruleB.priority) ||
    cmpLowestNumber(ruleA.actionPrecedence(), ruleB.actionPrecedence()) ||
    // As noted in the top-of-file comment, the following two comparisons only
    // exist to have a stable ordering of rules; they match Chrome's behavior.
    cmpLowestNumber(rulesetA.rulesetPrecedence, rulesetB.rulesetPrecedence) ||
    cmpLowestNumber(ruleA.id, ruleB.id)
  )
}

class MatchedRule {
  /** @param {Rule} rule @param {Ruleset} ruleset */
  constructor(rule, ruleset) {
    this.rule = rule
    this.ruleset = ruleset
  }

  // The RuleManager that generated this MatchedRule.
  get ruleManager() {
    return this.ruleset.ruleManager
  }
}

// Domain lists in rule conditions (requestDomains, excludedRequestDomains,
// initiatorDomains, excludedInitiatorDomains) could be really long, containing
// thousands of entries. We convert them to Set for faster lookup.
const gDomainsListToSet = new DefaultWeakMap(domains => new Set(domains))

// Patch 7 (UPSTREAM.md): RequestDetails no longer builds itself from a
// Firefox ChannelWrapper/browsingContext. It is constructed directly from
// Orivon's request shape (dnr-engine.ts's DnrRequest), and its ancestor
// chain -- used only for allowAllRequests frame inheritance -- is supplied
// by the caller (frame-ancestry.ts) instead of walked from a live frame
// tree, which a pure engine does not have. See this file's top comment and
// the facade README's Design notes.
class RequestDetails {
  /**
   * @param {object} options
   * @param {URL} options.requestURI
   * @param {URL|null} [options.initiatorURI]
   * @param {string} options.type - Chrome ResourceType.
   * @param {string} [options.method] - lower-case HTTP method.
   * @param {number} [options.tabId]
   * @param {RequestDetails[]} [options.ancestorRequestDetails] - Root-frame
   *   first. Empty for a main_frame request, or when the caller has not
   *   recorded the frame's ancestry yet.
   */
  constructor({
    requestURI,
    initiatorURI = null,
    type,
    method = 'get',
    tabId = -1,
    ancestorRequestDetails = [],
  }) {
    this.requestURI = requestURI
    this.initiatorURI = initiatorURI
    this.type = type
    this.method = method
    this.tabId = tabId
    this.ancestorRequestDetails = ancestorRequestDetails

    const requestDomain = this.#domainFromURI(requestURI)
    const initiatorDomain = initiatorURI ? this.#domainFromURI(initiatorURI) : null
    this.allRequestDomains = requestDomain && this.#getAllDomainsWithin(requestDomain)
    this.allInitiatorDomains = initiatorDomain && this.#getAllDomainsWithin(initiatorDomain)

    this.domainType = this.#isThirdParty(requestURI, initiatorURI) ? 'thirdParty' : 'firstParty'

    this.requestURIspec = requestURI.href
    this.requestDataForUrlFilter = new RequestDataForUrlFilter(this.requestURIspec)
  }

  #isThirdParty(requestURI, initiatorURI) {
    if (!initiatorURI) {
      // E.g. main_frame request or opaque origin.
      return true
    }
    const baseA = getBaseDomain(requestURI.hostname)
    const baseB = getBaseDomain(initiatorURI.hostname)
    if (baseA != null && baseB != null) {
      return baseA !== baseB
    }
    // getBaseDomain returns null for an IP address or a host lacking a known
    // public suffix (e.g. localhost); fall back to plain host comparison.
    return this.#domainFromURI(requestURI) !== this.#domainFromURI(initiatorURI)
  }

  #domainFromURI(uri) {
    const hostname = uri.hostname
    // WHATWG URL already brackets an IPv6 hostname; only add brackets when
    // missing, so we never double-wrap.
    return hostname.includes(':') && !hostname.startsWith('[') ? `[${hostname}]` : hostname
  }

  /**
   * @param {string} domain - The canonical representation of the host of a URL.
   * @returns {string[]} A non-empty list of the domain and all superdomains
   *   within the given domain. This may include items that are not resolvable
   *   domains, such as "com" (from input "example.com").
   */
  #getAllDomainsWithin(domain) {
    const domains = [domain]
    let i = 0
    // Reminder: domain cannot start with a dot, nor contain consecutive dots.
    while ((i = domain.indexOf('.', i) + 1) !== 0) {
      const superdomain = domain.slice(i)
      // A full domain can end with a dot (FQDN) such as "example.com.", in
      // which case the last domain should be "com." and not "".
      if (superdomain) {
        domains.push(superdomain)
      }
    }
    return domains
  }
}

/**
 * This RequestEvaluator class's logic is documented at the top of this file.
 * Patch 8 (UPSTREAM.md) dropped the original's #isRuleActionAllowed and its
 * hasBlockPermission checks entirely, along with every other permission
 * check (host-permission gating is a broker/manifest concern, not part of
 * rule matching -- see the top-of-file comment). Patch 12 reinstates one
 * piece of it: #isActionAllowed, gating `redirect`/`modifyHeaders` (and,
 * for an extension holding only declarativeNetRequestWithHostAccess, every
 * action) on a per-RuleManager `actionAccess.hasHostAccess` predicate the
 * caller supplies -- see #isActionAllowed's own doc.
 */
class RequestEvaluator {
  // private constructor, only used by RequestEvaluator.evaluateRequest.
  constructor(request, ruleManager) {
    this.req = request
    this.ruleManager = ruleManager

    // These values are initialized by findMatchingRules():
    this.matchedRule = null
    this.matchedModifyHeadersRules = []
    this.didCheckAncestors = false
    this.findMatchingRules()
  }

  /**
   * Finds the matched rules for the given request and extensions, according
   * to the logic documented at the top of this file.
   *
   * @param {RequestDetails} request
   * @param {RuleManager[]} ruleManagers - ordered by extension importance
   *   (most recently registered first).
   * @returns {MatchedRule[]}
   */
  static evaluateRequest(request, ruleManagers) {
    // Helper to determine precedence of rules from different extensions.
    function precedence(matchedRule) {
      switch (matchedRule.rule.action.type) {
        case 'block':
          return 1
        case 'redirect':
        case 'upgradeScheme':
          return 2
        case 'allow':
        case 'allowAllRequests':
          return 3
        default:
          throw new Error(`Unexpected action: ${matchedRule.rule.action.type}`)
      }
    }

    const requestEvaluators = []
    let finalMatch
    for (const ruleManager of ruleManagers) {
      const requestEvaluator = new RequestEvaluator(request, ruleManager)
      requestEvaluators.push(requestEvaluator)
      let matchedRule = requestEvaluator.matchedRule
      if (matchedRule && (!finalMatch || precedence(matchedRule) < precedence(finalMatch))) {
        // Before choosing the matched rule as finalMatch, check whether there
        // is an allowAllRequests rule override among the ancestors.
        requestEvaluator.findAncestorRuleOverride()
        matchedRule = requestEvaluator.matchedRule
        if (!finalMatch || precedence(matchedRule) < precedence(finalMatch)) {
          finalMatch = matchedRule
          if (finalMatch.rule.action.type === 'block') {
            break
          }
        }
      }
    }
    if (finalMatch && !finalMatch.rule.isAllowOrAllowAllRequestsAction()) {
      // Found block/redirect/upgradeScheme, request will be replaced.
      return [finalMatch]
    }
    // Request not canceled, collect all modifyHeaders actions:
    let matchedRules = requestEvaluators.map(re => re.getMatchingModifyHeadersRules()).flat(1)

    // ... and collect the allowAllRequests actions, for callers that want to
    // report every matched rule, not just the winning one:
    const finalAllowAllRequestsMatches = []
    for (const requestEvaluator of requestEvaluators) {
      const matchedRule = requestEvaluator.matchedRule
      if (matchedRule && matchedRule.rule.action.type === 'allowAllRequests') {
        finalAllowAllRequestsMatches.push(matchedRule)
      }
    }
    if (finalAllowAllRequestsMatches.length) {
      matchedRules = finalAllowAllRequestsMatches.concat(matchedRules)
    }

    // ... and collect the "allow" action. At this point, finalMatch could also
    // be a modifyHeaders or allowAllRequests action, but these would already
    // have been added to the matchedRules result before.
    if (finalMatch && finalMatch.rule.action.type === 'allow') {
      matchedRules.unshift(finalMatch)
    }
    return matchedRules
  }

  /** Finds the matching rules, as documented in the comment before the class. */
  findMatchingRules() {
    this.#collectMatchInRuleset(this.ruleManager.sessionRules)
    this.#collectMatchInRuleset(this.ruleManager.dynamicRules)
    for (const ruleset of this.ruleManager.enabledStaticRules) {
      this.#collectMatchInRuleset(ruleset)
    }
  }

  /**
   * Find an "allowAllRequests" rule among the ancestors that may override the
   * current matchedRule and/or matchedModifyHeadersRules rules.
   */
  findAncestorRuleOverride() {
    if (this.didCheckAncestors) {
      return
    }
    this.didCheckAncestors = true

    if (!this.ruleManager.hasRulesWithAllowAllRequests) {
      // Optimization: skip ancestor lookup if there are no allowAllRequests rules.
      return
    }

    if (
      (!this.matchedRule || this.matchedRule.rule.isAllowOrAllowAllRequestsAction()) &&
      !this.matchedModifyHeadersRules.length
    ) {
      // Optimization: no existing match means no allowAllRequests ancestor
      // could change the outcome.
      return
    }

    for (const request of this.req.ancestorRequestDetails) {
      const requestEvaluator = new RequestEvaluator(request, this.ruleManager)
      const ancestorMatchedRule = requestEvaluator.matchedRule
      if (
        ancestorMatchedRule &&
        ancestorMatchedRule.rule.action.type === 'allowAllRequests' &&
        (!this.matchedRule ||
          compareRule(
            this.matchedRule.rule,
            ancestorMatchedRule.rule,
            this.matchedRule.ruleset,
            ancestorMatchedRule.ruleset
          ) > 0)
      ) {
        // Found an allowAllRequests rule that takes precedence over whatever
        // the current rule was.
        this.matchedRule = ancestorMatchedRule
      }
    }
  }

  /**
   * Retrieves the list of matched modifyHeaders rules that should apply.
   *
   * @returns {MatchedRule[]}
   */
  getMatchingModifyHeadersRules() {
    if (this.matchedModifyHeadersRules.length) {
      this.findAncestorRuleOverride()
    }
    // The minimum priority is 1. Defaulting to 0 = include all.
    let priorityThreshold = 0
    if (this.matchedRule?.rule.isAllowOrAllowAllRequestsAction()) {
      priorityThreshold = this.matchedRule.rule.priority
    }
    const matchedRules = this.matchedModifyHeadersRules.filter(matchedRule => {
      return matchedRule.rule.priority > priorityThreshold
    })
    // Sort output for a deterministic order.
    matchedRules.sort((a, b) => compareRule(a.rule, b.rule, a.ruleset, b.ruleset))
    return matchedRules
  }

  /** @param {Ruleset} ruleset */
  #collectMatchInRuleset(ruleset) {
    // Patch 10 (UPSTREAM.md): candidate pre-selection via the ruleset's
    // index, instead of always scanning every rule.
    const rules = ruleIndexEnabled
      ? ruleset.getCandidateRules(this.req.allRequestDomains, this.req.requestDataForUrlFilter)
      : ruleset.rules
    for (const rule of rules) {
      if (ruleset.disabledRuleIds?.has(rule.id)) {
        continue
      }
      if (!this.#matchesRuleCondition(rule.condition)) {
        continue
      }
      if (!this.#isActionAllowed(rule)) {
        continue
      }
      if (rule.action.type === 'modifyHeaders') {
        this.matchedModifyHeadersRules.push(new MatchedRule(rule, ruleset))
        continue
      }
      if (
        this.matchedRule &&
        compareRule(this.matchedRule.rule, rule, this.matchedRule.ruleset, ruleset) <= 0
      ) {
        continue
      }
      this.matchedRule = new MatchedRule(rule, ruleset)
    }
  }

  /**
   * Patch 12 (UPSTREAM.md): host-permission gating. Chrome grants `block`,
   * `allow`, `allowAllRequests` and `upgradeScheme` to any extension holding
   * plain `declarativeNetRequest`, but restricts `redirect` and
   * `modifyHeaders` to a request (and, when known, its initiator) the
   * extension holds host permission for; `declarativeNetRequestWithHostAccess`
   * instead requires host permission for every action type. A rule this
   * disqualifies is treated as though it never matched -- skipped here,
   * inside candidate collection, so a lower-precedence rule (this
   * extension's own, or another extension's) is still free to win, the same
   * outcome Chrome's own per-candidate check produces. `RuleManager#actionAccess`
   * defaults to "always allowed" (`DEFAULT_ACTION_ACCESS`), so an engine
   * whose caller never calls `setActionAccess` matches exactly as before
   * this patch.
   * @param {Rule} rule
   * @returns {boolean}
   */
  #isActionAllowed(rule) {
    const access = this.ruleManager.actionAccess
    const type = rule.action.type
    const needsHostAccess =
      access.requiresHostAccessForAllActions || type === 'redirect' || type === 'modifyHeaders'
    return !needsHostAccess || access.hasHostAccess(this.req.requestURI, this.req.initiatorURI)
  }

  /** @param {RuleCondition} cond @returns {boolean} Whether the condition matched. */
  #matchesRuleCondition(cond) {
    if (cond.resourceTypes) {
      if (!cond.resourceTypes.includes(this.req.type)) {
        return false
      }
    } else if (cond.excludedResourceTypes) {
      if (cond.excludedResourceTypes.includes(this.req.type)) {
        return false
      }
    } else if (this.req.type === 'main_frame') {
      // When resourceTypes/excludedResourceTypes are not specified, the
      // documented behavior is to ignore main_frame requests.
      return false
    }

    if (cond.urlFilter) {
      if (!cond.urlFilterMatches(this.req.requestDataForUrlFilter)) {
        return false
      }
    } else if (cond.regexFilter) {
      if (!cond.getCompiledRegexFilter().test(this.req.requestURIspec)) {
        return false
      }
    }
    if (
      cond.excludedRequestDomains &&
      this.#matchesDomains(cond.excludedRequestDomains, this.req.allRequestDomains)
    ) {
      return false
    }
    if (
      cond.requestDomains &&
      !this.#matchesDomains(cond.requestDomains, this.req.allRequestDomains)
    ) {
      return false
    }
    if (
      cond.excludedInitiatorDomains &&
      this.req.allInitiatorDomains &&
      this.#matchesDomains(cond.excludedInitiatorDomains, this.req.allInitiatorDomains)
    ) {
      return false
    }
    if (
      cond.initiatorDomains &&
      (!this.req.allInitiatorDomains ||
        !this.#matchesDomains(cond.initiatorDomains, this.req.allInitiatorDomains))
    ) {
      return false
    }

    if (cond.domainType && cond.domainType !== this.req.domainType) {
      return false
    }

    if (cond.requestMethods) {
      if (!cond.requestMethods.includes(this.req.method)) {
        return false
      }
    } else if (cond.excludedRequestMethods?.includes(this.req.method)) {
      return false
    }

    if (cond.tabIds) {
      if (!cond.tabIds.includes(this.req.tabId)) {
        return false
      }
    } else if (cond.excludedTabIds?.includes(this.req.tabId)) {
      return false
    }

    return true
  }

  /**
   * @param {string[]} domainsInCondition - A potentially long list of
   *   canonicalized domain patterns that are part of a rule condition.
   * @param {string[]} targetDomains - The domain and superdomains within the
   *   original URI (see #getAllDomainsWithin).
   * @returns {boolean} Whether the actual host is a (sub)domain of any of the
   *   domains in the condition.
   */
  #matchesDomains(domainsInCondition, targetDomains) {
    const ruleDomainsSet = gDomainsListToSet.get(domainsInCondition)
    return targetDomains.some(domain => ruleDomainsSet.has(domain))
  }
}

// Patch 12 (UPSTREAM.md): a RuleManager's default action-access predicate --
// no host-permission restriction at all, i.e. this engine's pre-patch-12
// behavior ("evaluate() always matches as if the calling extension holds
// full declarativeNetRequest + host permissions", top-of-file comment).
const DEFAULT_ACTION_ACCESS = {
  hasHostAccess: () => true,
  requiresHostAccessForAllActions: false,
}

class RuleManager {
  constructor(extensionId) {
    this.extensionId = extensionId
    this.sessionRules = this.makeRuleset('_session', PRECEDENCE_SESSION_RULESET)
    this.dynamicRules = this.makeRuleset('_dynamic', PRECEDENCE_DYNAMIC_RULESET)
    this.enabledStaticRules = []

    this.hasRulesWithAllowAllRequests = false
    this.totalRulesCount = 0
    // Patch 12 (UPSTREAM.md): { hasHostAccess(requestURI, initiatorURI),
    // requiresHostAccessForAllActions } -- set via the registry's
    // setActionAccess, read by RequestEvaluator#isActionAllowed.
    this.actionAccess = DEFAULT_ACTION_ACCESS
  }

  get availableStaticRuleCount() {
    return Math.max(
      ExtensionDNRLimits.GUARANTEED_MINIMUM_STATIC_RULES -
        this.enabledStaticRules.reduce((acc, ruleset) => acc + ruleset.rules.length, 0),
      0
    )
  }

  get enabledStaticRulesetIds() {
    return this.enabledStaticRules.map(ruleset => ruleset.id)
  }

  makeRuleset(rulesetId, rulesetPrecedence, rules = [], disabledRuleIds = null) {
    return new Ruleset(rulesetId, rulesetPrecedence, rules, disabledRuleIds, this)
  }

  setSessionRules(validatedSessionRules) {
    const oldRulesCount = this.sessionRules.rules.length
    const newRulesCount = validatedSessionRules.length
    if (!oldRulesCount && !newRulesCount) {
      return
    }
    this.sessionRules.rules = validatedSessionRules
    this.totalRulesCount += newRulesCount - oldRulesCount
    this.#updateAllowAllRequestRules()
  }

  setDynamicRules(validatedDynamicRules) {
    const oldRulesCount = this.dynamicRules.rules.length
    const newRulesCount = validatedDynamicRules.length
    if (!oldRulesCount && !newRulesCount) {
      return
    }
    this.dynamicRules.rules = validatedDynamicRules
    this.totalRulesCount += newRulesCount - oldRulesCount
    this.#updateAllowAllRequestRules()
  }

  /**
   * @param {Array<{id, rules, disabledRuleIds}>} enabledStaticRulesets -
   *   ordered to match the manifest's rule_resources order.
   */
  setEnabledStaticRulesets(enabledStaticRulesets) {
    const rulesets = []
    for (const [idx, { id, rules, disabledRuleIds }] of enabledStaticRulesets.entries()) {
      rulesets.push(this.makeRuleset(id, idx + PRECEDENCE_STATIC_RULESETS_BASE, rules, disabledRuleIds))
    }
    const countRules = rs => rs.reduce((sum, ruleset) => sum + ruleset.rules.length, 0)
    const oldRulesCount = countRules(this.enabledStaticRules)
    const newRulesCount = countRules(rulesets)
    this.enabledStaticRules = rulesets
    this.totalRulesCount += newRulesCount - oldRulesCount
    this.#updateAllowAllRequestRules()
  }

  /** @param {number[]|null} [ruleIds] */
  getSessionRules(ruleIds = null) {
    if (!ruleIds) {
      return this.sessionRules.rules
    }
    return this.sessionRules.rules.filter(rule => ruleIds.includes(rule.id))
  }

  /** @param {number[]|null} [ruleIds] */
  getDynamicRules(ruleIds = null) {
    if (!ruleIds) {
      return this.dynamicRules.rules
    }
    return this.dynamicRules.rules.filter(rule => ruleIds.includes(rule.id))
  }

  getRulesCount() {
    return this.totalRulesCount
  }

  #updateAllowAllRequestRules() {
    const filterAAR = rule => rule.action.type === 'allowAllRequests'
    this.hasRulesWithAllowAllRequests =
      this.sessionRules.rules.some(filterAAR) ||
      this.dynamicRules.rules.some(filterAAR) ||
      this.enabledStaticRules.some(ruleset => ruleset.rules.some(filterAAR))
  }
}

// Patch 9 (UPSTREAM.md): upstream's gRuleManagers is one process-wide array,
// searched by `rm => rm.extension === extension` (a live Extension object;
// Firefox runs one DNR system per process). dnr-engine.ts's createDnrEngine()
// makes an independent engine per call (one per browsing session), so the
// registry is a factory instead of a module-level singleton: each engine
// gets its own Map, keyed by the extensionId string. Insertion order still
// doubles as "most recently registered first" for cross-extension
// precedence, same caveat as upstream (a real install-time ordering is not
// available here either).
function createRuleManagerRegistry() {
  const ruleManagers = new Map()

  function getRuleManager(extensionId, createIfMissing = true) {
    let ruleManager = ruleManagers.get(extensionId)
    if (!ruleManager && createIfMissing) {
      ruleManager = new RuleManager(extensionId)
      ruleManagers.set(extensionId, ruleManager)
    }
    return ruleManager
  }

  function removeRuleManager(extensionId) {
    ruleManagers.delete(extensionId)
  }

  /** @returns {RuleManager[]} Most recently registered extension first. */
  function getAllRuleManagersMostRecentFirst() {
    return Array.from(ruleManagers.values()).reverse()
  }

  /**
   * Patch 12 (UPSTREAM.md): sets (creating the RuleManager if needed) the
   * host-permission predicate RequestEvaluator#isActionAllowed gates
   * `redirect`/`modifyHeaders` on for this extension.
   * @param {string} extensionId
   * @param {{hasHostAccess: (requestURI: URL, initiatorURI: URL|null) => boolean, requiresHostAccessForAllActions: boolean}} actionAccess
   */
  function setActionAccess(extensionId, actionAccess) {
    getRuleManager(extensionId).actionAccess = actionAccess
  }

  return {
    getRuleManager,
    removeRuleManager,
    getAllRuleManagersMostRecentFirst,
    setActionAccess,
  }
}

// exports used by dnr-engine.ts.
export const ExtensionDNR = {
  RuleValidator,
  RuleQuotaCounter,
  RequestDetails,
  RequestEvaluator,
  createRuleManagerRegistry,
  applyRegexSubstitution,
  applyURLTransform,
  ModifyRequestHeaders,
  ModifyResponseHeaders,
  // Test-only: forces #collectMatchInRuleset back to a full scan of
  // ruleset.rules, so a test can compare indexed and unindexed evaluation
  // over the same rules and requests. Never called by dnr-engine.ts.
  __setRuleIndexEnabledForTesting(enabled) {
    ruleIndexEnabled = enabled
  },
}
