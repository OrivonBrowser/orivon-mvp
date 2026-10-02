// What the observers saw, read by the e2e test through this page's WebContents.
window.__wrLog = []

const ALL_URLS = { urls: ['<all_urls>'] }

chrome.webRequest.onBeforeRequest.addListener((details) => {
  const { pathname } = new URL(details.url)
  if (pathname.startsWith('/wr-ads/')) return { cancel: true }
  if (pathname === '/wr-redirect') return { redirectUrl: chrome.runtime.getURL('web_accessible_resources/redirected.js') }
  return undefined
}, ALL_URLS, ['blocking'])

chrome.webRequest.onBeforeSendHeaders.addListener((details) => {
  const requestHeaders = details.requestHeaders.filter((header) => header.name.toLowerCase() !== 'x-wr-test')
  requestHeaders.push({ name: 'x-wr-test', value: '1' })
  return { requestHeaders }
}, ALL_URLS, ['blocking', 'requestHeaders'])

chrome.webRequest.onHeadersReceived.addListener((details) => {
  const responseHeaders = details.responseHeaders.filter((header) => header.name.toLowerCase() !== 'x-wr-response')
  responseHeaders.push({ name: 'x-wr-response', value: '1' })
  return { responseHeaders }
}, ALL_URLS, ['blocking', 'responseHeaders'])

for (const event of ['onSendHeaders', 'onResponseStarted', 'onBeforeRedirect', 'onCompleted', 'onErrorOccurred']) {
  chrome.webRequest[event].addListener((details) => {
    window.__wrLog.push({
      event,
      url: details.url,
      type: details.type,
      tabId: details.tabId,
      frameId: details.frameId,
      parentFrameId: details.parentFrameId,
      initiator: details.initiator,
      statusCode: details.statusCode,
      error: details.error
    })
  }, ALL_URLS)
}
