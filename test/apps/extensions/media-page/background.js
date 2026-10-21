// Opens the offscreen document on request, and relays the test's question to it.
chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
  if (message.target === 'offscreen') return undefined
  void (async () => {
    if (message.cmd === 'ask-offscreen') {
      if (!(await chrome.offscreen.hasDocument())) {
        await chrome.offscreen.createDocument({ url: 'offscreen.html', reasons: ['USER_MEDIA'], justification: 'fixture: ask for a device without a window' })
      }
      sendResponse(await chrome.runtime.sendMessage({ target: 'offscreen', cmd: 'ask', constraints: message.constraints }))
    }
  })()
  return true
})
