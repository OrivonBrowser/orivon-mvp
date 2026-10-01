// A content blocker's service worker, reduced. Real blockers take
// `self.browser || self.chrome` and use whichever it is, and the first call
// fails the whole worker when that object lacks chrome.permissions.
const api = self.browser || self.chrome
api.permissions.onRemoved.addListener(() => {})
api.webRequest.onHeadersReceived.addListener(() => {}, { urls: ['<all_urls>'] })

// Electron never fires runtime.onInstalled for a loaded extension, so what a
// real blocker does on install is done at every worker start, once per page.
async function onStart () {
  if ((await chrome.tabs.query({ url: chrome.runtime.getURL('welcome.html') })).length === 0) {
    await chrome.tabs.create({ url: chrome.runtime.getURL('welcome.html') })
  }
  try {
    await chrome.offscreen.createDocument({ url: 'offscreen.html', reasons: ['DOM_PARSER'], justification: 'parse filter lists' })
  } catch (error) {
    console.error('offscreen failed', String(error))
  }
}
onStart().catch((error) => console.error('start failed', String(error)))

chrome.scripting.unregisterContentScripts().catch(() => {}).then(() => chrome.scripting.registerContentScripts([
  { id: 'main', js: ['main-world.js'], matches: ['<all_urls>'], runAt: 'document_start', world: 'MAIN', persistAcrossSessions: false }
])).catch((error) => console.error('register failed', String(error)))
