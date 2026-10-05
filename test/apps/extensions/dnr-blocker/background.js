// Fixture service worker for test/extensions/e2e-extensions-dnr.test.ts. Adds its own
// dynamic rules once per service-worker start; idempotent (removes its own
// ids first) since the worker can restart and its previously persisted
// dynamic rules would otherwise collide on id.
chrome.declarativeNetRequest.updateDynamicRules({
  removeRuleIds: [101, 102],
  addRules: [
    {
      id: 101,
      priority: 1,
      action: { type: 'redirect', redirect: { transform: { path: '/to-fixture' } } },
      condition: { urlFilter: '/from-fixture', resourceTypes: ['xmlhttprequest'] }
    },
    {
      id: 102,
      priority: 1,
      action: {
        type: 'modifyHeaders',
        responseHeaders: [{ header: 'x-dnr-test', operation: 'set', value: '1' }]
      },
      condition: { urlFilter: '/header-me', resourceTypes: ['xmlhttprequest'] }
    }
  ]
})

// Sized from the API's own constant, as a real blocker does: when the constant
// is missing the arithmetic gives NaN, no rule is added and /regex-blocked.js loads.
const dnr = chrome.declarativeNetRequest
if (0 < dnr.MAX_NUMBER_OF_REGEX_RULES * 0.95) {
  dnr.updateSessionRules({
    removeRuleIds: [201],
    addRules: [{
      id: 201,
      priority: 1,
      action: { type: dnr.RuleActionType.BLOCK },
      condition: { regexFilter: '^https?://[^/]+/regex-blocked\\.js', resourceTypes: [dnr.ResourceType.SCRIPT] }
    }]
  })
}
