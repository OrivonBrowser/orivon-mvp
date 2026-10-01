// A content blocker's service worker, reduced. Real blockers take
// `self.browser || self.chrome` and use whichever it is, and the first call
// fails the whole worker when that object lacks chrome.permissions.
const api = self.browser || self.chrome
api.permissions.onRemoved.addListener(() => {})
api.webRequest.onHeadersReceived.addListener(() => {}, { urls: ['<all_urls>'] })
// uBOL starts by reading its own ruleset list from the manifest.
console.log('rulesets:' + api.runtime.getManifest().declarative_net_request.rule_resources.map((r) => r.id).join(','))

// What a real blocker does on install: a welcome page, and a document to parse filter lists in.
chrome.runtime.onInstalled.addListener(async (details) => {
  console.log('installed:' + JSON.stringify(details))
  await chrome.tabs.create({ url: chrome.runtime.getURL('welcome.html') })
})

chrome.offscreen.createDocument({ url: 'offscreen.html', reasons: ['DOM_PARSER'], justification: 'parse filter lists' })
  .catch((error) => console.error('offscreen failed', String(error)))

chrome.scripting.unregisterContentScripts().catch(() => {}).then(() => chrome.scripting.registerContentScripts([
  { id: 'main', js: ['main-world.js'], matches: ['<all_urls>'], runAt: 'document_start', world: 'MAIN', persistAcrossSessions: false }
])).catch((error) => console.error('register failed', String(error)))
