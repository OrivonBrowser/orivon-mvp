// What a name-resolution extension does: when a top-level request to a .eth name fails, it takes the tab to a page of its own.
// The two lists are read by the e2e test through this page's WebContents.
window.__heard = []
window.__takeovers = []

chrome.webRequest.onErrorOccurred.addListener((details) => {
  if (details.tabId === -1) return
  window.__takeovers.push({ url: details.url, error: details.error, tabId: details.tabId })
  chrome.tabs.update(details.tabId, { url: chrome.runtime.getURL('taken.html') })
}, { urls: ['*://*.eth/*'], types: ['main_frame'] })

const EVENTS = ['onBeforeRequest', 'onBeforeSendHeaders', 'onSendHeaders', 'onHeadersReceived', 'onResponseStarted', 'onBeforeRedirect', 'onCompleted', 'onErrorOccurred']

for (const event of EVENTS) {
  chrome.webRequest[event].addListener((details) => {
    window.__heard.push({ event, url: details.url, type: details.type, tabId: details.tabId, frameId: details.frameId, statusCode: details.statusCode, error: details.error, at: Date.now() })
  }, { urls: ['<all_urls>'], types: ['main_frame', 'sub_frame'] })
}

// Every listener above is registered; the e2e test waits for this before it navigates.
window.__ready = true
