import type { Crx } from './crx.js'

/**
 * The constants and enums of `chrome.declarativeNetRequest`, over the library's
 * object of that name, which carries the methods and none of these. The values
 * are the engine's own: tests/declarative-net-request.test.ts compares them with
 * vendor/firefox-dnr/src/dnr-limits.mjs and src/main/extensions/dnr/types.ts, so
 * a limit changed there fails the test here. `RuleConditionKeys` lists the
 * condition keys the engine evaluates and no more: an extension that checks for
 * `TOP_DOMAINS` before sending `topDomains` rules finds it absent.
 */
export function declarativeNetRequestApi (): void {
  const crx = (globalThis as unknown as { __crx: Crx }).__crx
  crx.define('declarativeNetRequest', (base) => {
    const frozen = <T extends object>(value: T): Readonly<T> => Object.freeze(value)
    return {
      ...base,
      GUARANTEED_MINIMUM_STATIC_RULES: 30000,
      MAX_NUMBER_OF_STATIC_RULESETS: 100,
      MAX_NUMBER_OF_ENABLED_STATIC_RULESETS: 50,
      MAX_NUMBER_OF_DISABLED_STATIC_RULES: 5000,
      MAX_NUMBER_OF_DYNAMIC_RULES: 30000,
      MAX_NUMBER_OF_SESSION_RULES: 5000,
      MAX_NUMBER_OF_REGEX_RULES: 1000,
      // Chrome's published values for what the engine does not define: it keeps
      // no separate quota for "unsafe" rules (every dynamic or session rule
      // counts toward the totals above), does not limit getMatchedRules calls,
      // and only reports a regex the platform RegExp refuses.
      MAX_NUMBER_OF_DYNAMIC_AND_SESSION_RULES: 5000,
      MAX_NUMBER_OF_UNSAFE_DYNAMIC_RULES: 5000,
      MAX_NUMBER_OF_UNSAFE_SESSION_RULES: 5000,
      GETMATCHEDRULES_QUOTA_INTERVAL: 10,
      MAX_GETMATCHEDRULES_CALLS_PER_INTERVAL: 20,
      DYNAMIC_RULESET_ID: '_dynamic',
      SESSION_RULESET_ID: '_session',
      ResourceType: frozen({
        MAIN_FRAME: 'main_frame',
        SUB_FRAME: 'sub_frame',
        STYLESHEET: 'stylesheet',
        SCRIPT: 'script',
        IMAGE: 'image',
        FONT: 'font',
        OBJECT: 'object',
        XMLHTTPREQUEST: 'xmlhttprequest',
        PING: 'ping',
        CSP_REPORT: 'csp_report',
        MEDIA: 'media',
        WEBSOCKET: 'websocket',
        WEBTRANSPORT: 'webtransport',
        WEBBUNDLE: 'webbundle',
        OTHER: 'other'
      }),
      RuleActionType: frozen({
        BLOCK: 'block',
        REDIRECT: 'redirect',
        ALLOW: 'allow',
        UPGRADE_SCHEME: 'upgradeScheme',
        MODIFY_HEADERS: 'modifyHeaders',
        ALLOW_ALL_REQUESTS: 'allowAllRequests'
      }),
      RequestMethod: frozen({
        CONNECT: 'connect',
        DELETE: 'delete',
        GET: 'get',
        HEAD: 'head',
        OPTIONS: 'options',
        PATCH: 'patch',
        POST: 'post',
        PUT: 'put',
        OTHER: 'other'
      }),
      DomainType: frozen({ FIRST_PARTY: 'firstParty', THIRD_PARTY: 'thirdParty' }),
      HeaderOperation: frozen({ APPEND: 'append', SET: 'set', REMOVE: 'remove' }),
      UnsupportedRegexReason: frozen({ SYNTAX_ERROR: 'syntaxError', MEMORY_LIMIT_EXCEEDED: 'memoryLimitExceeded' }),
      RuleConditionKeys: frozen({
        URL_FILTER: 'urlFilter',
        REGEX_FILTER: 'regexFilter',
        IS_URL_FILTER_CASE_SENSITIVE: 'isUrlFilterCaseSensitive',
        INITIATOR_DOMAINS: 'initiatorDomains',
        EXCLUDED_INITIATOR_DOMAINS: 'excludedInitiatorDomains',
        REQUEST_DOMAINS: 'requestDomains',
        EXCLUDED_REQUEST_DOMAINS: 'excludedRequestDomains',
        RESOURCE_TYPES: 'resourceTypes',
        EXCLUDED_RESOURCE_TYPES: 'excludedResourceTypes',
        REQUEST_METHODS: 'requestMethods',
        EXCLUDED_REQUEST_METHODS: 'excludedRequestMethods',
        DOMAIN_TYPE: 'domainType',
        TAB_IDS: 'tabIds',
        EXCLUDED_TAB_IDS: 'excludedTabIds'
      })
    }
  })
}
