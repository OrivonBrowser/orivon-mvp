chrome.webRequest.onBeforeRequest.addListener(
  (details) => { return {} },
  { urls: ['<all_urls>'] },
  ['blocking']
)
