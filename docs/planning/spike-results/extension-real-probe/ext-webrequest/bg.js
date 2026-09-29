const status = { hasWebRequest: typeof chrome.webRequest, observeCount: 0, blockingRegistered: null, observeRegistered: null }
try {
  chrome.webRequest.onBeforeRequest.addListener((d) => {
    status.observeCount++
  }, { urls: ['<all_urls>'] })
  status.observeRegistered = 'ok'
} catch (e) { status.observeRegistered = 'threw:' + String(e && e.message || e) }
try {
  chrome.webRequest.onBeforeRequest.addListener((d) => {
    if (d.url.includes('/probe-block/wrblock.js')) return { cancel: true }
    return {}
  }, { urls: ['<all_urls>'] }, ['blocking'])
  status.blockingRegistered = 'ok'
} catch (e) { status.blockingRegistered = 'threw:' + String(e && e.message || e) }
chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  if (msg && msg.kind === 'wr-status') { sendResponse(status); return true }
})
