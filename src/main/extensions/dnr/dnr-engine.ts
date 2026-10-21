import { ExtensionDNR } from '../../../../vendor/firefox-dnr/src/extension-dnr.mjs'
import { ExtensionDNRLimits } from '../../../../vendor/firefox-dnr/src/dnr-limits.mjs'
import { FrameAncestryTracker } from './frame-ancestry.js'
import type {
  DnrActionAccess,
  DnrDecision,
  DnrMatchedRuleInfo,
  DnrRequest,
  DnrRule,
  DnrStaticRuleset,
  DnrUpdateRuleOptions,
  DnrUpdateRulesetOptions,
} from './types.js'

// vendor/firefox-dnr/src/extension-dnr.mjs is plain JS (see its own header
// for why): these two aliases give the classes this file calls into a name,
// without claiming types the vendored file itself does not declare.
type VendorRuleValidator = InstanceType<typeof ExtensionDNR.RuleValidator>
type VendorRuleQuotaCounter = InstanceType<typeof ExtensionDNR.RuleQuotaCounter>
type VendorMatchedRule = { rule: any; ruleset: any; ruleManager: any }

const { RuleValidator, RuleQuotaCounter, RequestDetails, RequestEvaluator } = ExtensionDNR

/** Chrome defaults an omitted rule priority to 1; the vendored validator expects it pre-filled. */
function withDefaultPriority(rules: DnrRule[]): DnrRule[] {
  return rules.map(rule => (rule.priority === undefined ? { ...rule, priority: 1 } : rule))
}

function validateOrThrow(
  validator: VendorRuleValidator,
  quotaCounter: VendorRuleQuotaCounter,
  rulesetId: string
): DnrRule[] {
  const failures = validator.getFailures()
  if (failures.length) {
    throw new Error(failures[0].message)
  }
  const validated = validator.getValidatedRules()
  quotaCounter.tryAddRules(rulesetId, validated)
  return validated
}

/** Strips the vendored `Rule`/`RuleCondition` wrapper classes back to plain data. */
function serializeRule(rule: { id: number; priority: number; condition: object; action: object }): DnrRule {
  return {
    id: rule.id,
    priority: rule.priority,
    condition: { ...rule.condition },
    action: rule.action,
  } as DnrRule
}

interface StaticRulesetEntry {
  enabled: boolean
  /** A function until first read: a disabled ruleset's file is not parsed before it is enabled. */
  rules: DnrRule[] | (() => DnrRule[])
}

/** Chrome's global static rule pool: rules an extension enables beyond its
 * GUARANTEED_MINIMUM_STATIC_RULES draw on this, shared by every extension. */
export const GLOBAL_STATIC_RULE_POOL = 300_000

export interface DnrEngineOptions {
  /** Defaults to GLOBAL_STATIC_RULE_POOL; tests shrink it. */
  globalStaticRulePool?: number
}

/** Per-extension bookkeeping the vendored RuleManager does not retain: disabled rulesets' rules. */
interface StaticState {
  /** In manifest ("rule_resources") order. */
  order: string[]
  byId: Map<string, StaticRulesetEntry>
  /** Enabled by the manifest but not loaded for want of quota: not reported as enabled, still kept as enabled when the choice is saved. */
  skipped: Set<string>
}

/** A deferred ruleset read runs once, however many times the ruleset is enabled and disabled. */
function memoizedRules(rules: DnrRule[] | (() => DnrRule[])): DnrRule[] | (() => DnrRule[]) {
  if (typeof rules !== 'function') return rules
  let read: DnrRule[] | undefined
  return () => (read ??= rules())
}

function computeRedirectUrl(matchedRule: VendorMatchedRule, requestURI: URL): string | null {
  const redirect = matchedRule.rule.action.redirect
  if (!redirect) {
    return null
  }
  const extensionId = matchedRule.ruleManager.extensionId as string
  if (redirect.url) {
    // Already validated in full at rule-add time (RuleValidator's own
    // #checkActionRedirect, vendor/firefox-dnr/UPSTREAM.md patch 16): a
    // static, request-independent string that cannot have changed since.
    return redirect.url
  }
  if (redirect.extensionPath) {
    // Orivon serves an extension's own resources at chrome-extension://<id>/,
    // matching electron-chrome-extensions's convention (extensionId is the
    // host). See this directory's README section Design notes.
    return `chrome-extension://${extensionId}${redirect.extensionPath}`
  }
  if (redirect.transform) {
    // Unlike redirect.url, the final scheme/host here can depend on
    // requestURI (a field transform.* leaves unset inherits it) -- README
    // section Design notes has why validation alone cannot rule out every case,
    // and why this defence-in-depth check must run against the real URL.
    const transformed = ExtensionDNR.applyURLTransform(requestURI, redirect.transform)
    return ExtensionDNR.isRedirectTargetAllowed(transformed, extensionId) ? transformed.href : null
  }
  if (redirect.regexSubstitution) {
    // A rule this far has already been validated; a failure here means the
    // capture groups produced an unusable target for this particular URL.
    // Treated as "no redirect" rather than surfaced, so one bad extension
    // rule cannot fail an unrelated page load.
    try {
      const substituted = ExtensionDNR.applyRegexSubstitution(matchedRule, requestURI)
      return ExtensionDNR.isRedirectTargetAllowed(substituted, extensionId) ? substituted.href : null
    } catch {
      return null
    }
  }
  return null
}

function toMatchedRuleInfo(matchedRules: VendorMatchedRule[]): DnrMatchedRuleInfo[] {
  return matchedRules.map(mr => ({
    extensionId: mr.ruleManager.extensionId as string,
    rulesetId: mr.ruleset.id as string,
    ruleId: mr.rule.id as number,
    actionType: mr.rule.action.type as DnrMatchedRuleInfo['actionType'],
  }))
}

function buildDecision(matchedRules: VendorMatchedRule[], requestURI: URL): DnrDecision {
  const matchedRuleInfo = toMatchedRuleInfo(matchedRules)
  if (matchedRules.length === 1) {
    const winner = matchedRules[0]!
    switch (winner.rule.action.type) {
      case 'block':
        return { cancel: true, matchedRules: matchedRuleInfo }
      case 'upgradeScheme':
        return { upgradeToHttps: true, matchedRules: matchedRuleInfo }
      case 'redirect': {
        const redirectUrl = computeRedirectUrl(winner, requestURI)
        return redirectUrl ? { redirectUrl, matchedRules: matchedRuleInfo } : { matchedRules: matchedRuleInfo }
      }
      default:
        break
    }
  }
  const decision: DnrDecision = { matchedRules: matchedRuleInfo }
  const requestHeaders = ExtensionDNR.ModifyRequestHeaders.maybeApplyModifyHeaders(matchedRules)
  const responseHeaders = ExtensionDNR.ModifyResponseHeaders.maybeApplyModifyHeaders(matchedRules)
  if (requestHeaders.length) {
    decision.requestHeaders = requestHeaders
  }
  if (responseHeaders.length) {
    decision.responseHeaders = responseHeaders
  }
  return decision
}

function parseUrlOrNull(spec: string | null | undefined): URL | null {
  if (!spec) {
    return null
  }
  try {
    return new URL(spec)
  } catch {
    return null
  }
}

/**
 * Creates a fresh, in-memory `declarativeNetRequest` engine. See this
 * directory's README for what it does and does not own.
 */
export function createDnrEngine(options: DnrEngineOptions = {}) {
  const globalPool = options.globalStaticRulePool ?? GLOBAL_STATIC_RULE_POOL
  /** Per extension: enabled static rules beyond the guaranteed minimum. */
  const poolUse = new Map<string, number>()
  /** Per extension: enabled static rules in all. */
  const enabledTotals = new Map<string, number>()
  const registry = ExtensionDNR.createRuleManagerRegistry()
  const staticState = new Map<string, StaticState>()
  const frameAncestry = new FrameAncestryTracker()

  function poolUsedByOthers(extensionId: string): number {
    let used = 0
    for (const [id, extra] of poolUse) {
      if (id !== extensionId) used += extra
    }
    return used
  }

  function readRules(entry: StaticRulesetEntry): DnrRule[] {
    return typeof entry.rules === 'function' ? entry.rules() : entry.rules
  }

  /**
   * Validates and applies the given `enabledIds` (manifest order already
   * applied by the caller) as `extensionId`'s enabled static rulesets: the
   * one function that can fail on a quota, so both `setStaticRulesets` and
   * `updateEnabledRulesets` (which has prior state to protect, see its own
   * doc) route through it with the FULL proposed set, never a partially
   * mutated one.
   *
   * Rules up to GUARANTEED_MINIMUM_STATIC_RULES are the extension's own;
   * beyond that they draw on the global pool other extensions share
   * (Chrome's model). `skipWhatDoesNotFit` is for loading a manifest's
   * defaults, where Chrome keeps the rulesets that fit and ignores the
   * rest; a runtime enable (false) throws instead. Unlike a dynamic or
   * session update, an individual invalid rule is dropped, not fatal:
   * RuleValidator#addRules already skips it and Chrome keeps loading the
   * rest of the ruleset. Returns the ids applied.
   */
  function applyEnabledStaticRulesets(
    extensionId: string,
    state: StaticState,
    enabledIds: readonly string[],
    skipWhatDoesNotFit: boolean
  ): string[] {
    if (enabledIds.length > ExtensionDNRLimits.MAX_NUMBER_OF_ENABLED_STATIC_RULESETS) {
      throw new Error(
        `Enabled static rulesets exceed MAX_NUMBER_OF_ENABLED_STATIC_RULESETS (${ExtensionDNRLimits.MAX_NUMBER_OF_ENABLED_STATIC_RULESETS}).`
      )
    }
    const poolAvailable = globalPool - poolUsedByOthers(extensionId)
    let total = 0
    let regexTotal = 0
    const applied: Array<{ id: string, rules: DnrRule[] }> = []
    for (const id of enabledIds) {
      const entry = state.byId.get(id)!
      const validator: VendorRuleValidator = new RuleValidator([], { extensionId })
      validator.addRules(withDefaultPriority(readRules(entry)))
      const rules = validator.getValidatedRules() as DnrRule[]
      const regexCount = rules.filter(rule => rule.condition.regexFilter).length
      const extra = Math.max(0, total + rules.length - ExtensionDNRLimits.GUARANTEED_MINIMUM_STATIC_RULES)
      const overRules = extra > poolAvailable
      const overRegex = regexTotal + regexCount > ExtensionDNRLimits.MAX_NUMBER_OF_REGEX_RULES
      if (overRules || overRegex) {
        const what = overRules
          ? `Number of rules across all enabled static rulesets exceeds the global static rule limit (GUARANTEED_MINIMUM_STATIC_RULES plus the shared pool of ${String(globalPool)})`
          : 'Number of regexFilter rules across all enabled static rulesets exceeds MAX_NUMBER_OF_REGEX_RULES'
        if (!skipWhatDoesNotFit) throw new Error(`${what} if ruleset "${id}" were to be enabled.`)
        console.warn(`[dnr] ${extensionId}: ruleset "${id}" not loaded: ${what}.`)
        state.byId.set(id, { ...entry, enabled: false })
        state.skipped.add(id)
        continue
      }
      total += rules.length
      regexTotal += regexCount
      applied.push({ id, rules })
    }
    registry.getRuleManager(extensionId).setEnabledStaticRulesets(
      applied.map(({ id, rules }) => ({ id, rules, disabledRuleIds: null }))
    )
    enabledTotals.set(extensionId, total)
    poolUse.set(extensionId, Math.max(0, total - ExtensionDNRLimits.GUARANTEED_MINIMUM_STATIC_RULES))
    return applied.map(({ id }) => id)
  }

  function enabledIdsInOrder(state: StaticState): string[] {
    return state.order.filter(id => state.byId.get(id)!.enabled)
  }

  return {
    setStaticRulesets(extensionId: string, rulesets: DnrStaticRuleset[]): void {
      if (rulesets.length > ExtensionDNRLimits.MAX_NUMBER_OF_STATIC_RULESETS) {
        throw new Error(
          `Static rulesets exceed MAX_NUMBER_OF_STATIC_RULESETS (${ExtensionDNRLimits.MAX_NUMBER_OF_STATIC_RULESETS}).`
        )
      }
      const seen = new Set<string>()
      for (const ruleset of rulesets) {
        if (seen.has(ruleset.id)) {
          throw new Error(`Duplicate static ruleset id: "${ruleset.id}"`)
        }
        seen.add(ruleset.id)
      }
      const state: StaticState = {
        order: rulesets.map(r => r.id),
        byId: new Map(rulesets.map(r => [r.id, { enabled: r.enabled, rules: memoizedRules(r.rules) }])),
        skipped: new Set(),
      }
      staticState.set(extensionId, state)
      applyEnabledStaticRulesets(extensionId, state, enabledIdsInOrder(state), true)
    },

    /**
     * Validates the PROPOSED enabled set (every id, the enabled-count limit
     * and each newly-enabled ruleset's own quota) against a copy of
     * `state.byId`'s flags before touching the real ones: a rejected call
     * (an unknown id, too many rulesets enabled, or a set that passes the
     * global static rule limit -- the guarantee plus the shared pool -- or
     * MAX_NUMBER_OF_REGEX_RULES once actually validated) must
     * change nothing at all, not leave some ids flipped and others not.
     * Applying the flags to a scratch Map first, computing the proposed
     * enabled-id list from THAT, and only committing it onto `state.byId`
     * after `applyEnabledStaticRulesets` returns without throwing is what
     * makes this call atomic either way.
     */
    updateEnabledRulesets(extensionId: string, options: DnrUpdateRulesetOptions): void {
      const state = staticState.get(extensionId)
      if (!state) {
        return
      }
      const disableIds = options.disableRulesetIds ?? []
      const enableIds = options.enableRulesetIds ?? []
      for (const id of [...enableIds, ...disableIds]) {
        if (!state.byId.has(id)) {
          throw new Error(`Invalid ruleset id: "${id}"`)
        }
      }
      const proposedFlags = new Map(state.byId)
      for (const id of disableIds) {
        proposedFlags.set(id, { ...proposedFlags.get(id)!, enabled: false })
      }
      for (const id of enableIds) {
        proposedFlags.set(id, { ...proposedFlags.get(id)!, enabled: true })
      }
      const proposedEnabledIds = state.order.filter(id => proposedFlags.get(id)!.enabled)
      applyEnabledStaticRulesets(extensionId, state, proposedEnabledIds, false)
      // Only reached once the proposed set validated and applied cleanly.
      state.byId = proposedFlags
      for (const id of [...enableIds, ...disableIds]) state.skipped.delete(id)
    },

    updateDynamicRules(extensionId: string, options: DnrUpdateRuleOptions): void {
      const ruleManager = registry.getRuleManager(extensionId)
      const validator: VendorRuleValidator = new RuleValidator(ruleManager.getDynamicRules(), { extensionId })
      if (options.removeRuleIds) {
        validator.removeRuleIds(options.removeRuleIds)
      }
      if (options.addRules) {
        validator.addRules(withDefaultPriority(options.addRules))
      }
      const quotaCounter = new RuleQuotaCounter('MAX_NUMBER_OF_DYNAMIC_RULES')
      const validated = validateOrThrow(validator, quotaCounter, '_dynamic')
      ruleManager.setDynamicRules(validated)
    },

    updateSessionRules(extensionId: string, options: DnrUpdateRuleOptions): void {
      const ruleManager = registry.getRuleManager(extensionId)
      const validator: VendorRuleValidator = new RuleValidator(ruleManager.getSessionRules(), {
        isSessionRuleset: true,
        extensionId,
      })
      if (options.removeRuleIds) {
        validator.removeRuleIds(options.removeRuleIds)
      }
      if (options.addRules) {
        validator.addRules(withDefaultPriority(options.addRules))
      }
      const quotaCounter = new RuleQuotaCounter('MAX_NUMBER_OF_SESSION_RULES')
      const validated = validateOrThrow(validator, quotaCounter, '_session')
      ruleManager.setSessionRules(validated)
    },

    getDynamicRules(extensionId: string): DnrRule[] {
      const ruleManager = registry.getRuleManager(extensionId, false)
      return ruleManager ? ruleManager.getDynamicRules().map(serializeRule) : []
    },

    getSessionRules(extensionId: string): DnrRule[] {
      const ruleManager = registry.getRuleManager(extensionId, false)
      return ruleManager ? ruleManager.getSessionRules().map(serializeRule) : []
    },

    /** The static ruleset ids currently enabled, in manifest order --
     * `chrome.declarativeNetRequest.getEnabledRulesets`. */
    getEnabledRulesets(extensionId: string): string[] {
      const ruleManager = registry.getRuleManager(extensionId, false)
      return ruleManager ? [...ruleManager.enabledStaticRulesetIds] : []
    },

    /** What to save as the enabled choice: the enabled rulesets plus any the manifest enabled that did not fit the pool, so a later boot tries them again. */
    getEnabledRulesetsToPersist(extensionId: string): string[] {
      const enabled = [...(registry.getRuleManager(extensionId, false)?.enabledStaticRulesetIds ?? [])]
      const state = staticState.get(extensionId)
      if (state === undefined || state.skipped.size === 0) return enabled
      return state.order.filter((id) => enabled.includes(id) || state.skipped.has(id))
    },

    /** `chrome.declarativeNetRequest.getAvailableStaticRuleCount`. */
    getAvailableStaticRuleCount(extensionId: string): number {
      const ruleManager = registry.getRuleManager(extensionId, false)
      if (!ruleManager) return ExtensionDNRLimits.GUARANTEED_MINIMUM_STATIC_RULES + globalPool - poolUsedByOthers(extensionId)
      const own = ExtensionDNRLimits.GUARANTEED_MINIMUM_STATIC_RULES - (enabledTotals.get(extensionId) ?? 0)
      const pool = globalPool - poolUsedByOthers(extensionId) - (poolUse.get(extensionId) ?? 0)
      return Math.max(own, 0) + Math.max(pool, 0)
    },

    /**
     * `chrome.declarativeNetRequest.testMatchOutcome`: evaluates `request`
     * against only `extensionId`'s own rules (Chrome never lets an
     * extension test another's), ignoring host-permission gating the same
     * way Chrome's own `testMatchOutcome` does (it reports what WOULD
     * match, not what would actually apply).
     */
    testMatch(extensionId: string, request: DnrRequest): DnrMatchedRuleInfo[] {
      const ruleManager = registry.getRuleManager(extensionId, false)
      if (!ruleManager) {
        return []
      }
      const requestURI = new URL(request.url)
      const requestDetails = new RequestDetails({
        requestURI,
        initiatorURI: parseUrlOrNull(request.initiator),
        type: request.resourceType,
        method: request.method.toLowerCase(),
        tabId: request.tabId,
      })
      const previousAccess = ruleManager.actionAccess
      // testMatchOutcome reports every rule that WOULD match, unaffected by
      // host-permission gating (Chrome's own documented behavior) -- lift
      // this extension's own gate for the one evaluation, restore it after.
      ruleManager.actionAccess = { hasHostAccess: () => true, requiresHostAccessForAllActions: false }
      try {
        const matched = RequestEvaluator.evaluateRequest(requestDetails, [ruleManager]) as VendorMatchedRule[]
        return toMatchedRuleInfo(matched)
      } finally {
        ruleManager.actionAccess = previousAccess
      }
    },

    removeExtension(extensionId: string): void {
      staticState.delete(extensionId)
      poolUse.delete(extensionId)
      enabledTotals.delete(extensionId)
      registry.removeRuleManager(extensionId)
    },

    /**
     * Sets the host-permission gate `evaluate()` applies to this
     * extension's `redirect`/`modifyHeaders` rules (vendor/firefox-dnr's
     * `UPSTREAM.md` patch 12). Unset, an extension's rules match as if it
     * held full host permission everywhere -- this package's original
     * behavior (see this directory's README).
     */
    setActionAccess(extensionId: string, access: DnrActionAccess): void {
      registry.setActionAccess(extensionId, access)
    },

    evaluate(request: DnrRequest): DnrDecision {
      frameAncestry.record(request)

      const requestURI = new URL(request.url)
      const initiatorURI = parseUrlOrNull(request.initiator)

      const startFrameId =
        request.resourceType === 'main_frame'
          ? undefined
          : request.resourceType === 'sub_frame'
            ? request.parentFrameId
            : request.frameId
      const ancestorRequestDetails = frameAncestry
        .buildAncestorChain(request.tabId, startFrameId)
        .map(
          ancestor =>
            new RequestDetails({
              requestURI: new URL(ancestor.url),
              initiatorURI: parseUrlOrNull(ancestor.initiator),
              type: ancestor.type,
              method: ancestor.method,
              tabId: request.tabId,
            })
        )

      const requestDetails = new RequestDetails({
        requestURI,
        initiatorURI,
        type: request.resourceType,
        method: request.method.toLowerCase(),
        tabId: request.tabId,
        ancestorRequestDetails,
      })

      let ruleManagers = registry.getAllRuleManagersMostRecentFirst()
      // Chrome/Firefox default: a request from an extension's own page is
      // matched only against that extension's rules, not every extension's.
      if (initiatorURI?.protocol === 'chrome-extension:') {
        const initiatorExtensionId = initiatorURI.hostname
        ruleManagers = ruleManagers.filter(rm => rm.extensionId === initiatorExtensionId)
      }

      const matched = RequestEvaluator.evaluateRequest(requestDetails, ruleManagers) as VendorMatchedRule[]
      return buildDecision(matched, requestURI)
    },
  }
}

export type DnrEngine = ReturnType<typeof createDnrEngine>
