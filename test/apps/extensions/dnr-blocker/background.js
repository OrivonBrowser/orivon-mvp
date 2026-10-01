// Fixture service worker for test/e2e-extensions-dnr.test.ts. Adds its own
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
