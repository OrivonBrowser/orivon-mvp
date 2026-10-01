/**
 * The `declarativeNetRequest` rule shape, mirroring
 * `declarative_net_request.json` in the vendored Firefox source
 * (`vendor/firefox-dnr/UPSTREAM.md` has the exact revision). Field names and
 * meaning match Chrome's public schema; see
 * https://developer.chrome.com/docs/extensions/reference/api/declarativeNetRequest.
 */

export type DnrResourceType =
  | 'main_frame'
  | 'sub_frame'
  | 'stylesheet'
  | 'script'
  | 'image'
  | 'font'
  | 'object'
  | 'xmlhttprequest'
  | 'ping'
  | 'csp_report'
  | 'media'
  | 'websocket'
  | 'webtransport'
  | 'webbundle'
  | 'other'

export type DnrDomainType = 'firstParty' | 'thirdParty'
export type DnrRequestMethod =
  | 'connect'
  | 'delete'
  | 'get'
  | 'head'
  | 'options'
  | 'patch'
  | 'post'
  | 'put'
  | 'other'

export interface DnrRuleCondition {
  urlFilter?: string
  regexFilter?: string
  isUrlFilterCaseSensitive?: boolean
  initiatorDomains?: string[]
  excludedInitiatorDomains?: string[]
  requestDomains?: string[]
  excludedRequestDomains?: string[]
  resourceTypes?: DnrResourceType[]
  excludedResourceTypes?: DnrResourceType[]
  requestMethods?: DnrRequestMethod[]
  excludedRequestMethods?: DnrRequestMethod[]
  domainType?: DnrDomainType
  /** Session rules only; rejected by validation on dynamic/static rules. */
  tabIds?: number[]
  excludedTabIds?: number[]
}

export interface DnrQueryKeyValue {
  key: string
  value: string
  replaceOnly?: boolean
}

export interface DnrQueryTransform {
  addOrReplaceParams?: DnrQueryKeyValue[]
  removeParams?: string[]
}

export interface DnrUrlTransform {
  /** Chrome's own allowed values; dnr-engine.ts's computeRedirectUrl and the
   * vendored RuleValidator both refuse anything else (and refuse
   * "chrome-extension" unless it names the rule's own extension) -- see
   * this directory's README §Design notes. */
  scheme?: 'http' | 'https' | 'ftp' | 'chrome-extension'
  username?: string
  password?: string
  host?: string
  port?: string
  path?: string
  query?: string
  queryTransform?: DnrQueryTransform
  fragment?: string
}

export interface DnrRedirect {
  /** Same scheme allowlist as DnrUrlTransform.scheme (see its own doc). */
  url?: string
  extensionPath?: string
  transform?: DnrUrlTransform
  regexSubstitution?: string
}

export type DnrModifyHeaderOperation = 'append' | 'set' | 'remove'

export interface DnrModifyHeaderInfo {
  header: string
  operation: DnrModifyHeaderOperation
  value?: string
}

export type DnrActionType =
  | 'allow'
  | 'allowAllRequests'
  | 'block'
  | 'upgradeScheme'
  | 'redirect'
  | 'modifyHeaders'

export interface DnrRuleAction {
  type: DnrActionType
  redirect?: DnrRedirect
  requestHeaders?: DnrModifyHeaderInfo[]
  responseHeaders?: DnrModifyHeaderInfo[]
}

export interface DnrRule {
  id: number
  priority?: number
  condition: DnrRuleCondition
  action: DnrRuleAction
}

/** One entry of `setStaticRulesets`'s argument. */
export interface DnrStaticRuleset {
  id: string
  enabled: boolean
  /** A function defers reading a disabled ruleset's rules until it is first enabled. */
  rules: DnrRule[] | (() => DnrRule[])
}

export interface DnrUpdateRuleOptions {
  removeRuleIds?: number[]
  addRules?: DnrRule[]
}

export interface DnrUpdateRulesetOptions {
  enableRulesetIds?: string[]
  disableRulesetIds?: string[]
}

/**
 * A request to evaluate, shaped after `chrome.webRequest`'s
 * `OnBeforeRequestListenerDetails` rather than Electron's own event (Chrome's
 * `resourceType` names; `resource-types.ts` maps Electron's).
 */
export interface DnrRequest {
  url: string
  method: string
  resourceType: DnrResourceType
  /** The page or script that triggered the request, if any. */
  initiator?: string
  tabId: number
  frameId: number
  /** Absent for a main_frame request. */
  parentFrameId?: number
  /** The frame's own document URL, when already known (for ancestry). */
  documentUrl?: string
}

export type DnrModifyOps = DnrModifyHeaderInfo[]

export interface DnrMatchedRuleInfo {
  extensionId: string
  rulesetId: string
  ruleId: number
  /** The matched rule's own action type -- `dnr-api.ts`'s `onRuleMatched`
   * needs this to know whether a match should count toward the per-tab
   * action-count badge: Chrome counts `block`/`redirect`/`upgradeScheme`/
   * `modifyHeaders` matches, never `allow`/`allowAllRequests` (which report
   * through `getMatchedRules`/`onRuleMatchedDebug` the same as any other
   * match, just without incrementing the count). */
  actionType: DnrActionType
}

/**
 * The result of evaluating one request against every extension's rules.
 * At most one of `cancel`, `redirectUrl`, `upgradeToHttps` is set, because
 * they are mutually exclusive winning actions (see the README's Design
 * notes on precedence). `requestHeaders`/`responseHeaders` can be set
 * alongside an `allow`/`allowAllRequests` outcome (i.e. none of the three
 * above), or alongside no outcome at all.
 */
export interface DnrDecision {
  cancel?: true
  redirectUrl?: string
  upgradeToHttps?: true
  requestHeaders?: DnrModifyOps
  responseHeaders?: DnrModifyOps
  matchedRules: DnrMatchedRuleInfo[]
}

/**
 * What `redirect`/`modifyHeaders` (and, for a
 * `declarativeNetRequestWithHostAccess`-only extension, every action) are
 * gated on -- see `host-permissions.ts` and
 * `vendor/firefox-dnr/UPSTREAM.md` patch 12. `hasHostAccess` receives the
 * request URL always, and the initiator URL when one is known (`null`
 * otherwise, e.g. a top-level navigation); Chrome checks the initiator only
 * when there is one to check.
 */
export interface DnrActionAccess {
  hasHostAccess(requestURI: URL, initiatorURI: URL | null): boolean
  requiresHostAccessForAllActions: boolean
}
